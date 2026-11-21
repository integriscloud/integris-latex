import type { Prisma } from '@integris/db';
import {
  compareDashboardRows,
  type DashboardRow,
  type MySupervisors,
  type SupervisionAdmin,
  type SupervisionDashboard,
  urgencyOf,
} from '@integris/shared';
import {
  HttpStatus,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { consumeLimit } from '../common/rate-limit.js';
import { ApiConfig } from '../config/api-config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectEventsService } from '../projects/project-events.service.js';
import { RedisService } from '../redis/redis.service.js';
import {
  fail,
  type OrgActor,
  type OrgContext,
  OrgContextService,
  type Tx,
} from './org-context.service.js';

const LIVE = ['PENDING', 'ACTIVE'] as const;
const SWEEP_MS = 10 * 60_000;
/** Supervision requests per student and hour. */
const REQUESTS_PER_HOUR = 10;

/** Signed-in user acting on supervision. */
interface Actor extends OrgActor {
  userId: string;
}

/**
 * Supervisor–student links of a BUSINESS (docs/spec.md, "Encadrement" and the step 12
 * decisions): assigned by an admin, or asked by the student and accepted by the teacher; at most
 * the plan's `maxSupervisedStudents` per supervisor and organization. The link alone opens no
 * project: the student opens the projects of their choice (Supervisor role); when the link ends
 * (by an admin, at its end date, or when one of them leaves), those accesses are removed and the
 * comments stay. Every change writes an audit entry.
 */
@Injectable()
export class SupervisionService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SupervisionService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgs: OrgContextService,
    private readonly events: ProjectEventsService,
    private readonly redis: RedisService,
    private readonly config: ApiConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.runSweep(), SWEEP_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  // ───────────── Ending links ─────────────

  /**
   * Ends the live links matching `where` inside the caller's transaction and removes the project
   * accesses they gave. Returns the projects whose access changed (to tell open connections).
   */
  async endLinks(
    tx: Tx,
    actor: OrgActor,
    where: Prisma.SupervisionWhereInput,
    reason: string,
  ): Promise<string[]> {
    const links = await tx.supervision.findMany({
      where: { ...where, status: { in: [...LIVE] } },
    });
    const projects: string[] = [];
    const now = new Date();
    for (const link of links) {
      const accesses = await tx.projectMember.findMany({ where: { viaSupervisionId: link.id } });
      for (const access of accesses) {
        await tx.projectMember.delete({ where: { id: access.id } });
        await tx.auditLog.create({
          data: {
            actorId: actor.userId,
            action: 'PROJECT_ACCESS_REMOVED',
            targetType: 'Project',
            targetId: access.projectId,
            metadata: { userId: access.userId, role: access.role, supervisionId: link.id, reason },
            ip: actor.ip,
          },
        });
        projects.push(access.projectId);
      }
      await tx.supervision.update({
        where: { id: link.id },
        data: { status: 'ENDED', endedAt: now, endedById: actor.userId },
      });
      await this.orgs.audit(tx, actor, 'SUPERVISION_ENDED', 'Supervision', link.id, {
        organizationId: link.organizationId,
        supervisorId: link.supervisorId,
        studentId: link.studentId,
        from: link.status,
        reason,
        projects: accesses.map((access) => access.projectId),
      });
    }
    return projects;
  }

  /** Open editors and viewers check their rights again at once. */
  async accessChanged(projectIds: Iterable<string>): Promise<void> {
    for (const projectId of new Set(projectIds)) {
      await this.events.publish({ type: 'project-access', projectId });
    }
  }

  /** Links whose end date passed end by themselves. */
  async sweep(now = new Date()): Promise<number> {
    const due = await this.prisma.client.supervision.findMany({
      where: { status: { in: [...LIVE] }, endsAt: { lte: now } },
      select: { id: true, organizationId: true },
    });
    for (const { id, organizationId } of due) {
      const projects = await this.withLock(organizationId, () =>
        this.prisma.client.$transaction((tx) =>
          this.endLinks(tx, { userId: null, ip: null }, { id }, 'end_date'),
        ),
      );
      await this.accessChanged(projects);
    }
    return due.length;
  }

  private async runSweep(): Promise<void> {
    try {
      const lock = await this.redis.client.set('lock:supervision-sweep', '1', 'PX', SWEEP_MS, 'NX');
      if (lock !== 'OK') return;
      const ended = await this.sweep();
      if (ended) this.logger.log({ ended }, 'Supervision links ended at their end date');
    } catch (error) {
      this.logger.error({ err: error }, 'Supervision sweep failed');
    }
  }

  /**
   * Links open and end under the organization lock, so a project is never opened on a link that
   * is ending (its access would outlive the link).
   */
  private withLock<T>(organizationId: string | null, task: () => Promise<T>): Promise<T> {
    return organizationId ? this.orgs.locked(organizationId, task) : task();
  }

  // ───────────── Checks ─────────────

  private requireSupervision(context: OrgContext): void {
    this.orgs.requireBusiness(context);
    if (!context.subscription.plan.supervisionDashboard) fail(HttpStatus.CONFLICT, 'business_only');
  }

  private async member(
    tx: Tx,
    organizationId: string,
    userId: string,
    kind: 'TEACHER' | 'STUDENT',
  ) {
    const member = await tx.membership.findFirst({
      where: { organizationId, userId, status: 'ACTIVE' },
      include: { user: { select: { displayName: true } } },
    });
    if (!member || member.kind !== kind) {
      fail(HttpStatus.CONFLICT, kind === 'TEACHER' ? 'not_teacher' : 'not_student');
    }
    return member!;
  }

  /** Refuses a new link above the plan's limit of students per supervisor (pending ones count). */
  private async checkLimit(tx: Tx, context: OrgContext, supervisorId: string, except?: string) {
    const max = context.subscription.plan.maxSupervisedStudents;
    if (max === null) return;
    const count = await tx.supervision.count({
      where: {
        organizationId: context.organization.id,
        supervisorId,
        status: { in: [...LIVE] },
        ...(except ? { id: { not: except } } : {}),
      },
    });
    if (count >= max) fail(HttpStatus.CONFLICT, 'supervision_limit');
  }

  private checkEndDate(endsAt: string | null | undefined): Date | null {
    if (!endsAt) return null;
    const date = new Date(endsAt);
    if (date <= new Date()) fail(HttpStatus.UNPROCESSABLE_ENTITY, 'end_date_past');
    return date;
  }

  private notify(tx: Tx, userIds: string[], type: string, payload: Prisma.InputJsonObject) {
    return tx.notification.createMany({
      data: userIds.map((userId) => ({ userId, channel: 'IN_APP' as const, type, payload })),
    });
  }

  // ───────────── Admins ─────────────

  async adminView(userId: string, organizationId: string): Promise<SupervisionAdmin> {
    const context = await this.orgs.manager(userId, organizationId);
    this.requireSupervision(context);
    const db = this.prisma.client;
    const [links, members, groups] = await Promise.all([
      db.supervision.findMany({
        where: { organizationId, status: { in: [...LIVE] } },
        orderBy: { createdAt: 'asc' },
      }),
      db.membership.findMany({
        where: { organizationId, status: 'ACTIVE', kind: { in: ['TEACHER', 'STUDENT'] } },
        include: { user: { select: { displayName: true } } },
      }),
      db.orgGroup.findMany({ where: { organizationId }, orderBy: { name: 'asc' } }),
    ]);
    const byId = new Map(members.map((member) => [member.userId, member]));
    const name = (id: string) => byId.get(id)?.user.displayName ?? '';
    return {
      links: links.map((link) => ({
        id: link.id,
        supervisor: { id: link.supervisorId, name: name(link.supervisorId) },
        student: {
          id: link.studentId,
          name: name(link.studentId),
          groupId: byId.get(link.studentId)?.groupId ?? null,
        },
        status: link.status,
        assigned: link.assignedById !== null,
        startsAt: link.startsAt.toISOString(),
        endsAt: link.endsAt?.toISOString() ?? null,
      })),
      teachers: members
        .filter((member) => member.kind === 'TEACHER')
        .map((member) => ({
          id: member.userId,
          name: member.user.displayName,
          students: links.filter((link) => link.supervisorId === member.userId).length,
        })),
      students: members
        .filter((member) => member.kind === 'STUDENT')
        .map((member) => ({
          id: member.userId,
          name: member.user.displayName,
          groupId: member.groupId,
        })),
      groups: groups.map((group) => ({
        id: group.id,
        name: group.name,
        parentId: group.parentId,
        members: members.filter((member) => member.groupId === group.id).length,
      })),
      maxStudents: context.subscription.plan.maxSupervisedStudents,
    };
  }

  /** An admin assigns a supervisor: the link is active at once (a pending request becomes it). */
  async assign(
    actor: Actor,
    organizationId: string,
    body: { supervisorId: string; studentId: string; endsAt?: string | null },
  ): Promise<SupervisionAdmin> {
    const context = await this.orgs.manager(actor.userId, organizationId);
    this.requireSupervision(context);
    this.orgs.requireLive(context);
    const endsAt = this.checkEndDate(body.endsAt);
    await this.orgs.locked(organizationId, () =>
      this.prisma.client.$transaction(async (tx) => {
        await this.member(tx, organizationId, body.supervisorId, 'TEACHER');
        await this.member(tx, organizationId, body.studentId, 'STUDENT');
        const existing = await tx.supervision.findFirst({
          where: {
            organizationId,
            supervisorId: body.supervisorId,
            studentId: body.studentId,
            status: { in: [...LIVE] },
          },
        });
        if (existing?.status === 'ACTIVE') fail(HttpStatus.CONFLICT, 'supervision_exists');
        await this.checkLimit(tx, context, body.supervisorId, existing?.id);
        const link = existing
          ? await tx.supervision.update({
              where: { id: existing.id },
              data: { status: 'ACTIVE', assignedById: actor.userId, startsAt: new Date(), endsAt },
            })
          : await tx.supervision.create({
              data: {
                organizationId,
                supervisorId: body.supervisorId,
                studentId: body.studentId,
                status: 'ACTIVE',
                assignedById: actor.userId,
                endsAt,
              },
            });
        await this.orgs.audit(tx, actor, 'SUPERVISION_ASSIGNED', 'Supervision', link.id, {
          organizationId,
          supervisorId: body.supervisorId,
          studentId: body.studentId,
          endsAt: endsAt?.toISOString() ?? null,
        });
        await this.notify(tx, [body.supervisorId, body.studentId], 'SUPERVISION_ASSIGNED', {
          organizationId,
          supervisionId: link.id,
        });
      }),
    );
    return this.adminView(actor.userId, organizationId);
  }

  async setEndDate(
    actor: Actor,
    organizationId: string,
    supervisionId: string,
    endsAtInput: string | null,
  ): Promise<SupervisionAdmin> {
    const context = await this.orgs.manager(actor.userId, organizationId);
    this.requireSupervision(context);
    const endsAt = this.checkEndDate(endsAtInput);
    await this.prisma.client.$transaction(async (tx) => {
      const link = await tx.supervision.findFirst({
        where: { id: supervisionId, organizationId, status: { in: [...LIVE] } },
      });
      if (!link) return fail(HttpStatus.NOT_FOUND, 'supervision_not_found');
      await tx.supervision.update({ where: { id: link.id }, data: { endsAt } });
      await this.orgs.audit(tx, actor, 'SUPERVISION_END_DATE_SET', 'Supervision', link.id, {
        organizationId,
        from: link.endsAt?.toISOString() ?? null,
        to: endsAt?.toISOString() ?? null,
      });
    });
    return this.adminView(actor.userId, organizationId);
  }

  async end(
    actor: Actor,
    organizationId: string,
    supervisionId: string,
  ): Promise<SupervisionAdmin> {
    const context = await this.orgs.manager(actor.userId, organizationId);
    this.requireSupervision(context);
    const projects = await this.orgs.locked(organizationId, () =>
      this.prisma.client.$transaction(async (tx) => {
        const link = await tx.supervision.findFirst({
          where: { id: supervisionId, organizationId, status: { in: [...LIVE] } },
        });
        if (!link) return fail(HttpStatus.NOT_FOUND, 'supervision_not_found');
        const ended = await this.endLinks(tx, actor, { id: link.id }, 'ended_by_admin');
        await this.notify(tx, [link.supervisorId, link.studentId], 'SUPERVISION_ENDED', {
          organizationId,
          supervisionId: link.id,
        });
        return ended;
      }),
    );
    await this.accessChanged(projects);
    return this.adminView(actor.userId, organizationId);
  }

  /**
   * Reassignment: the former supervisor loses the link and the accesses it gave (comments stay);
   * the new link starts without any project: the student opens them again.
   */
  async reassign(
    actor: Actor,
    organizationId: string,
    supervisionId: string,
    supervisorId: string,
  ): Promise<SupervisionAdmin> {
    const context = await this.orgs.manager(actor.userId, organizationId);
    this.requireSupervision(context);
    this.orgs.requireLive(context);
    const projects = await this.orgs.locked(organizationId, () =>
      this.prisma.client.$transaction(async (tx) => {
        const link = await tx.supervision.findFirst({
          where: { id: supervisionId, organizationId, status: { in: [...LIVE] } },
        });
        if (!link) return fail(HttpStatus.NOT_FOUND, 'supervision_not_found');
        if (link.supervisorId === supervisorId) fail(HttpStatus.CONFLICT, 'supervision_exists');
        await this.member(tx, organizationId, supervisorId, 'TEACHER');
        const other = await tx.supervision.findFirst({
          where: {
            organizationId,
            supervisorId,
            studentId: link.studentId,
            status: { in: [...LIVE] },
          },
        });
        if (other) fail(HttpStatus.CONFLICT, 'supervision_exists');
        await this.checkLimit(tx, context, supervisorId);
        const ended = await this.endLinks(tx, actor, { id: link.id }, 'reassigned');
        const next = await tx.supervision.create({
          data: {
            organizationId,
            supervisorId,
            studentId: link.studentId,
            status: 'ACTIVE',
            assignedById: actor.userId,
            endsAt: link.endsAt,
          },
        });
        await this.orgs.audit(tx, actor, 'SUPERVISION_REASSIGNED', 'Supervision', next.id, {
          organizationId,
          previousId: link.id,
          from: link.supervisorId,
          to: supervisorId,
          studentId: link.studentId,
        });
        await this.notify(
          tx,
          [link.supervisorId, supervisorId, link.studentId],
          'SUPERVISION_REASSIGNED',
          { organizationId, supervisionId: next.id },
        );
        return ended;
      }),
    );
    await this.accessChanged(projects);
    return this.adminView(actor.userId, organizationId);
  }

  // ───────────── Students ─────────────

  async mine(userId: string, organizationId: string): Promise<MySupervisors> {
    const context = await this.orgs.load(userId, organizationId);
    this.requireSupervision(context);
    if (context.membership.kind !== 'STUDENT') fail(HttpStatus.CONFLICT, 'not_student');
    const db = this.prisma.client;
    const [links, teachers, projects] = await Promise.all([
      db.supervision.findMany({
        where: { organizationId, studentId: userId, status: { in: [...LIVE] } },
        include: {
          supervisor: { select: { displayName: true } },
          projectAccesses: {
            include: { project: { select: { id: true, name: true, deletedAt: true } } },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      db.membership.findMany({
        where: { organizationId, status: 'ACTIVE', kind: 'TEACHER', userId: { not: userId } },
        include: { user: { select: { displayName: true } } },
      }),
      db.project.findMany({
        where: { ownerId: userId, deletedAt: null, kind: 'DOCUMENT' },
        select: { id: true, name: true },
        orderBy: { lastActivityAt: 'desc' },
      }),
    ]);
    return {
      links: links.map((link) => ({
        id: link.id,
        supervisor: { id: link.supervisorId, name: link.supervisor.displayName },
        status: link.status as 'PENDING' | 'ACTIVE',
        endsAt: link.endsAt?.toISOString() ?? null,
        projects: link.projectAccesses
          .filter((access) => !access.project.deletedAt)
          .map((access) => ({ id: access.project.id, name: access.project.name })),
      })),
      teachers: teachers
        .map((teacher) => ({ id: teacher.userId, name: teacher.user.displayName }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      projects: projects.map((project) => ({ id: project.id, name: project.name })),
    };
  }

  /** The student asks a teacher of the organization; the teacher accepts or declines. */
  async request(
    actor: Actor,
    organizationId: string,
    supervisorId: string,
  ): Promise<MySupervisors> {
    const context = await this.orgs.load(actor.userId, organizationId);
    this.requireSupervision(context);
    this.orgs.requireLive(context);
    if (context.membership.kind !== 'STUDENT') fail(HttpStatus.CONFLICT, 'not_student');
    // Asking then canceling again and again would flood a teacher with notifications.
    await consumeLimit(
      this.redis.client,
      `rl:supervision-request:${actor.userId}`,
      REQUESTS_PER_HOUR,
      3600,
    );
    await this.orgs.locked(organizationId, () =>
      this.prisma.client.$transaction(async (tx) => {
        await this.member(tx, organizationId, supervisorId, 'TEACHER');
        const existing = await tx.supervision.findFirst({
          where: {
            organizationId,
            supervisorId,
            studentId: actor.userId,
            status: { in: [...LIVE] },
          },
        });
        if (existing) fail(HttpStatus.CONFLICT, 'supervision_exists');
        await this.checkLimit(tx, context, supervisorId);
        const link = await tx.supervision.create({
          data: { organizationId, supervisorId, studentId: actor.userId, status: 'PENDING' },
        });
        await this.orgs.audit(tx, actor, 'SUPERVISION_REQUESTED', 'Supervision', link.id, {
          organizationId,
          supervisorId,
          studentId: actor.userId,
        });
        await this.notify(tx, [supervisorId], 'SUPERVISION_REQUESTED', {
          organizationId,
          supervisionId: link.id,
        });
      }),
    );
    return this.mine(actor.userId, organizationId);
  }

  /** The student withdraws a request not answered yet. */
  async cancel(actor: Actor, supervisionId: string): Promise<void> {
    const link = await this.prisma.client.supervision.findFirst({
      where: { id: supervisionId, studentId: actor.userId, status: 'PENDING' },
    });
    if (!link) return fail(HttpStatus.NOT_FOUND, 'supervision_not_found');
    await this.withLock(link.organizationId, () =>
      this.prisma.client.$transaction((tx) =>
        this.endLinks(tx, actor, { id: link.id, status: 'PENDING' }, 'canceled_by_student'),
      ),
    );
  }

  /** Opens one of the student's projects to their supervisor (Supervisor role, no invitation). */
  async openProject(actor: Actor, supervisionId: string, projectId: string): Promise<void> {
    const found = await this.prisma.client.supervision.findFirst({
      where: { id: supervisionId, studentId: actor.userId, status: 'ACTIVE' },
    });
    if (!found?.organizationId) return fail(HttpStatus.NOT_FOUND, 'supervision_not_found');
    const context = await this.orgs.load(actor.userId, found.organizationId);
    this.requireSupervision(context);
    this.orgs.requireLive(context);
    await this.orgs.locked(found.organizationId, () =>
      this.prisma.client.$transaction(async (tx) => {
        // Read again under the lock: still active and before its end date.
        const now = new Date();
        const link = await tx.supervision.findFirst({
          where: {
            id: supervisionId,
            studentId: actor.userId,
            status: 'ACTIVE',
            OR: [{ endsAt: null }, { endsAt: { gt: now } }],
          },
        });
        if (!link) return fail(HttpStatus.NOT_FOUND, 'supervision_not_found');
        // Documents only: an exam paper (step 13) never leaves its teacher.
        const project = await tx.project.findFirst({
          where: { id: projectId, ownerId: actor.userId, deletedAt: null, kind: 'DOCUMENT' },
        });
        if (!project) return fail(HttpStatus.NOT_FOUND, 'not_found');
        const member = await tx.projectMember.findUnique({
          where: { projectId_userId: { projectId, userId: link.supervisorId } },
        });
        // An access given otherwise (sharing) stays as it is and is not taken back with the link.
        if (member) return;
        await tx.projectMember.create({
          data: {
            projectId,
            userId: link.supervisorId,
            role: 'SUPERVISOR',
            viaSupervisionId: link.id,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: actor.userId,
            action: 'PROJECT_SHARED',
            targetType: 'Project',
            targetId: projectId,
            metadata: { userId: link.supervisorId, role: 'SUPERVISOR', supervisionId: link.id },
            ip: actor.ip,
          },
        });
      }),
    );
    await this.accessChanged([projectId]);
  }

  async closeProject(actor: Actor, supervisionId: string, projectId: string): Promise<void> {
    await this.prisma.client.$transaction(async (tx) => {
      const link = await tx.supervision.findFirst({
        where: { id: supervisionId, studentId: actor.userId },
      });
      if (!link) return fail(HttpStatus.NOT_FOUND, 'supervision_not_found');
      const access = await tx.projectMember.findFirst({
        where: { projectId, userId: link.supervisorId, viaSupervisionId: link.id },
      });
      if (!access) return fail(HttpStatus.NOT_FOUND, 'not_found');
      await tx.projectMember.delete({ where: { id: access.id } });
      await tx.auditLog.create({
        data: {
          actorId: actor.userId,
          action: 'PROJECT_ACCESS_REMOVED',
          targetType: 'Project',
          targetId: projectId,
          metadata: { userId: link.supervisorId, role: access.role, supervisionId: link.id },
          ip: actor.ip,
        },
      });
    });
    await this.accessChanged([projectId]);
  }

  // ───────────── Teachers ─────────────

  async answer(actor: Actor, supervisionId: string, accept: boolean): Promise<void> {
    const link = await this.prisma.client.supervision.findFirst({
      where: { id: supervisionId, supervisorId: actor.userId, status: 'PENDING' },
    });
    if (!link?.organizationId) return fail(HttpStatus.NOT_FOUND, 'supervision_not_found');
    const context = await this.orgs.load(actor.userId, link.organizationId);
    if (!accept) {
      await this.orgs.locked(link.organizationId, () =>
        this.prisma.client.$transaction(async (tx) => {
          const still = await tx.supervision.count({ where: { id: link.id, status: 'PENDING' } });
          if (!still) return;
          await this.endLinks(tx, actor, { id: link.id }, 'declined');
          await this.notify(tx, [link.studentId], 'SUPERVISION_DECLINED', {
            organizationId: link.organizationId,
            supervisionId: link.id,
          });
        }),
      );
      return;
    }
    this.orgs.requireLive(context);
    await this.orgs.locked(link.organizationId, () =>
      this.prisma.client.$transaction(async (tx) => {
        await this.member(tx, link.organizationId!, link.studentId, 'STUDENT');
        await this.checkLimit(tx, context, actor.userId, link.id);
        const { count } = await tx.supervision.updateMany({
          where: { id: link.id, status: 'PENDING' },
          data: { status: 'ACTIVE', startsAt: new Date() },
        });
        if (!count) fail(HttpStatus.NOT_FOUND, 'supervision_not_found');
        await this.orgs.audit(tx, actor, 'SUPERVISION_ACCEPTED', 'Supervision', link.id, {
          organizationId: link.organizationId,
          supervisorId: link.supervisorId,
          studentId: link.studentId,
        });
        await this.notify(tx, [link.studentId], 'SUPERVISION_ACCEPTED', {
          organizationId: link.organizationId,
          supervisionId: link.id,
        });
      }),
    );
  }

  /**
   * Supervision dashboard (BUSINESS): one row per project opened by a followed student (a row
   * without project for a student who opened none), sorted by urgency.
   */
  async dashboard(userId: string, organizationId: string): Promise<SupervisionDashboard> {
    const context = await this.orgs.load(userId, organizationId);
    this.requireSupervision(context);
    if (context.membership.kind !== 'TEACHER') fail(HttpStatus.CONFLICT, 'not_teacher');
    const db = this.prisma.client;
    const links = await db.supervision.findMany({
      where: { organizationId, supervisorId: userId, status: { in: [...LIVE] } },
      include: {
        student: { select: { displayName: true } },
        projectAccesses: {
          include: {
            project: { select: { id: true, name: true, lastActivityAt: true, deletedAt: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    const students = links.map((link) => link.studentId);
    const [memberships, groups] = await Promise.all([
      db.membership.findMany({ where: { organizationId, userId: { in: students } } }),
      db.orgGroup.findMany({ where: { organizationId } }),
    ]);
    const groupOf = (studentId: string) => {
      const groupId = memberships.find((row) => row.userId === studentId)?.groupId;
      return groups.find((group) => group.id === groupId)?.name ?? null;
    };
    const active = links.filter((link) => link.status === 'ACTIVE');
    const projectIds = active.flatMap((link) =>
      link.projectAccesses
        .filter((access) => !access.project.deletedAt)
        .map((access) => access.projectId),
    );
    const submissions = projectIds.length
      ? await db.submission.findMany({
          where: { projectId: { in: projectIds }, status: { not: 'DRAFT' } },
          orderBy: { updatedAt: 'desc' },
          select: { id: true, projectId: true, title: true, status: true, dueAt: true },
        })
      : [];
    const now = new Date();
    const rows: DashboardRow[] = [];
    for (const link of active) {
      const student = {
        id: link.studentId,
        name: link.student.displayName,
        group: groupOf(link.studentId),
      };
      const opened = link.projectAccesses.filter((access) => !access.project.deletedAt);
      if (!opened.length) {
        rows.push({
          supervisionId: link.id,
          student,
          project: null,
          submission: null,
          submissions: 0,
          lastActivityAt: null,
          urgency: 'none',
        });
        continue;
      }
      for (const { project } of opened) {
        const own = submissions.filter((row) => row.projectId === project.id);
        const latest = own[0] ?? null;
        rows.push({
          supervisionId: link.id,
          student,
          project: { id: project.id, name: project.name },
          submission: latest && {
            id: latest.id,
            title: latest.title,
            status: latest.status,
            dueAt: latest.dueAt?.toISOString() ?? null,
          },
          submissions: own.length,
          lastActivityAt: project.lastActivityAt.toISOString(),
          urgency: urgencyOf(latest, now),
        });
      }
    }
    rows.sort(compareDashboardRows);
    return {
      rows,
      students: active.length,
      maxStudents: context.subscription.plan.maxSupervisedStudents,
      requests: links
        .filter((link) => link.status === 'PENDING')
        .map((link) => ({
          id: link.id,
          student: {
            id: link.studentId,
            name: link.student.displayName,
            group: groupOf(link.studentId),
          },
          createdAt: link.createdAt.toISOString(),
        })),
    };
  }
}
