import type { OrgGroup, PrintEvent, PrintRequest, Prisma } from '@integris/db';
import {
  PRINT_CANCELABLE,
  PRINT_EDITABLE,
  type PrintEventView,
  type PrintRequestView,
} from '@integris/shared';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { fail } from '../projects/projects.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  ancestorsOf,
  groupPath,
  sharedTeacherOrganization,
  subtreeOf,
  type Tx,
} from './exam-access.js';

export { fail };

/** What a user is for one print request (several at once: an admin may also be its teacher). */
export interface Reader {
  userId: string;
  /** Sent it (owner of the exam paper at the time). */
  teacher: boolean;
  /** Co-editor of its exam paper, now. */
  coeditor: boolean;
  /** Active secretariat member serving its class (or a parent group). */
  secretary: boolean;
  /** Owner or admin of its organization: metadata and journal, never the subject. */
  admin: boolean;
}

/** A secretariat membership: the groups it serves and every group below them. */
export interface SecretaryScope {
  organizationId: string;
  organizationName: string;
  scopeIds: string[];
  visible: Set<string>;
  groups: OrgGroup[];
}

type Db = Tx | PrismaService['client'];

/**
 * Access rules of the print requests (docs/spec.md, "Devoirs et secrétariat", and the step 13
 * decisions): who reads a request, what they may do, the move to READY when the availability date
 * is reached (with the in-app notice of the secretariat), and the views of requests and events.
 */
@Injectable()
export class PrintAccessService {
  private readonly logger = new Logger(PrintAccessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  get db() {
    return this.prisma.client;
  }

  /** The secretariat of a user in an organization, or null when they are not one. */
  async secretaryScope(
    userId: string,
    organizationId: string,
    db: Db = this.db,
  ): Promise<SecretaryScope | null> {
    const membership = await db.membership.findFirst({
      where: { userId, organizationId, status: 'ACTIVE', kind: 'SECRETARY' },
      include: {
        secretariatScopes: { select: { groupId: true } },
        organization: { select: { name: true, type: true } },
      },
    });
    if (!membership || membership.organization.type !== 'BUSINESS') return null;
    const groups = await db.orgGroup.findMany({ where: { organizationId } });
    const scopeIds = membership.secretariatScopes.map((scope) => scope.groupId);
    return {
      organizationId,
      organizationName: membership.organization.name,
      scopeIds,
      visible: subtreeOf(groups, scopeIds),
      groups,
    };
  }

  /** Active secretariat members serving a group (itself or one of its parents). */
  async secretariesOf(db: Db, organizationId: string, groupId: string): Promise<string[]> {
    const groups = await db.orgGroup.findMany({ where: { organizationId } });
    const ancestors = ancestorsOf(groups, groupId);
    const scopes = await db.secretariatScope.findMany({
      where: {
        groupId: { in: ancestors },
        membership: { organizationId, status: 'ACTIVE', kind: 'SECRETARY' },
      },
      include: { membership: { select: { userId: true } } },
    });
    return [...new Set(scopes.map((scope) => scope.membership.userId))];
  }

  async reader(userId: string, request: PrintRequest): Promise<Reader> {
    const db = this.db;
    const [coeditor, scope, manager, teaching] = await Promise.all([
      request.projectId
        ? db.projectMember.findFirst({
            where: {
              projectId: request.projectId,
              userId,
              role: 'EDITOR',
              project: { deletedAt: null, kind: 'ASSIGNMENT' },
            },
            include: { project: { select: { ownerId: true } } },
          })
        : null,
      this.secretaryScope(userId, request.organizationId),
      db.membership.findFirst({
        where: {
          userId,
          organizationId: request.organizationId,
          status: 'ACTIVE',
          role: { in: ['OWNER', 'ADMIN'] },
        },
      }),
      request.teacherId === userId
        ? db.membership.findFirst({
            where: {
              userId,
              organizationId: request.organizationId,
              status: 'ACTIVE',
              kind: 'TEACHER',
            },
          })
        : null,
    ]);
    return {
      userId,
      // The sender, while still a teacher of the organization (step 13 decisions): one who left
      // or lost the profile keeps neither the preview nor the changes of their former sends.
      teacher: teaching !== null,
      // Still a teacher of an organization of the owner, not only a member row (step 13).
      coeditor:
        coeditor !== null &&
        (await sharedTeacherOrganization(db, coeditor.project.ownerId, userId)) !== null,
      secretary: scope?.visible.has(request.groupId) ?? false,
      admin: manager !== null,
    };
  }

  /** The request and its reader; "not found" for anyone who may not see it. */
  async load(
    userId: string,
    requestId: string,
  ): Promise<{ request: PrintRequest; reader: Reader }> {
    await this.promoteReady({ id: requestId });
    const request = await this.db.printRequest.findUnique({ where: { id: requestId } });
    if (!request) return fail(HttpStatus.NOT_FOUND, 'print_not_found');
    const reader = await this.reader(userId, request);
    if (!reader.teacher && !reader.coeditor && !reader.secretary && !reader.admin) {
      return fail(HttpStatus.NOT_FOUND, 'print_not_found');
    }
    return { request, reader };
  }

  /**
   * The server refuses any opening before the availability date, whoever asks, owner and admins
   * of the organization included (docs/spec.md, "Verrouillage").
   */
  requireUnlocked(request: PrintRequest, now = new Date()): void {
    if (now < request.availableFrom) {
      const seconds = Math.ceil((request.availableFrom.getTime() - now.getTime()) / 1000);
      throw new ApiError(HttpStatus.FORBIDDEN, 'print_locked', seconds);
    }
  }

  // ───────────── READY ─────────────

  /**
   * Requests whose availability date is reached become READY, and the secretariat of their class
   * is told in the app (once per request and member). Called by every read and by the sweep.
   */
  async promoteReady(where: Prisma.PrintRequestWhereInput = {}, now = new Date()): Promise<number> {
    const due = await this.db.printRequest.findMany({
      where: { ...where, status: 'SCHEDULED', availableFrom: { lte: now } },
      select: { id: true },
      take: 200,
    });
    let promoted = 0;
    for (const { id } of due) {
      const { count } = await this.db.printRequest.updateMany({
        where: { id, status: 'SCHEDULED', availableFrom: { lte: now } },
        data: { status: 'READY' },
      });
      if (!count) continue;
      promoted++;
      const request = await this.db.printRequest.findUniqueOrThrow({ where: { id } });
      await this.notifyReady(this.db, request).catch((error: unknown) =>
        this.logger.error({ err: (error as Error).message, id }, 'Ready notice not written'),
      );
    }
    return promoted;
  }

  /** In-app notice to the secretariat of a request that is ready (e-mail if chosen, no SMS). */
  async notifyReady(db: Db, request: PrintRequest): Promise<void> {
    const userIds = await this.secretariesOf(db, request.organizationId, request.groupId);
    await this.notifications.notify(db, userIds, {
      type: 'PRINT_READY',
      payload: { printRequestId: request.id, title: request.title },
      key: `print-ready:${request.id}`,
    });
  }

  // ───────────── Views ─────────────

  /** Names needed by the views of these requests: groups, organizations, teachers. */
  async context(requests: Pick<PrintRequest, 'organizationId' | 'teacherId'>[]) {
    const organizationIds = [...new Set(requests.map((request) => request.organizationId))];
    const teacherIds = [...new Set(requests.map((request) => request.teacherId))];
    const [groups, organizations, teachers] = await Promise.all([
      organizationIds.length
        ? this.db.orgGroup.findMany({ where: { organizationId: { in: organizationIds } } })
        : [],
      organizationIds.length
        ? this.db.organization.findMany({
            where: { id: { in: organizationIds } },
            select: { id: true, name: true },
          })
        : [],
      teacherIds.length
        ? this.db.user.findMany({
            where: { id: { in: teacherIds } },
            select: { id: true, displayName: true },
          })
        : [],
    ]);
    return {
      groups,
      organizations: new Map(organizations.map((row) => [row.id, row.name])),
      teachers: new Map(teachers.map((row) => [row.id, row.displayName])),
    };
  }

  view(
    request: PrintRequest,
    reader: Reader,
    context: Awaited<ReturnType<PrintAccessService['context']>>,
    now = new Date(),
  ): PrintRequestView {
    const locked = now < request.availableFrom;
    const status = request.status;
    const open = status !== 'CANCELED';
    return {
      id: request.id,
      projectId: request.projectId,
      title: request.title,
      status,
      organizationName: context.organizations.get(request.organizationId) ?? '',
      groupId: request.groupId,
      groupName: groupPath(context.groups, request.groupId),
      teacherName: context.teachers.get(request.teacherId) ?? '',
      pages: request.pages,
      copies: request.copies,
      reserveCopies: request.reserveCopies,
      duplex: request.duplex,
      stapled: request.stapled,
      availableFrom: request.availableFrom.toISOString(),
      examAt: request.examAt.toISOString(),
      locked,
      printedCount: request.printedCount,
      handedOverTo: request.handedOverTo,
      openedAt: request.openedAt?.toISOString() ?? null,
      printedAt: request.printedAt?.toISOString() ?? null,
      handedOverAt: request.handedOverAt?.toISOString() ?? null,
      canceledAt: request.canceledAt?.toISOString() ?? null,
      replacedById: request.replacedById,
      createdAt: request.createdAt.toISOString(),
      can: {
        modify: reader.teacher && PRINT_EDITABLE.includes(status),
        cancel: reader.teacher && PRINT_CANCELABLE.includes(status),
        replace: reader.teacher && PRINT_EDITABLE.includes(status) && request.projectId !== null,
        // Admins never see the subject (step 13 decisions); nobody before the date.
        preview: (reader.secretary || reader.teacher || reader.coeditor) && open && !locked,
        print: reader.secretary && !locked && (status === 'OPENED' || status === 'PRINTED'),
        confirmPrinted: reader.secretary && status === 'OPENED',
        handOver: reader.secretary && status === 'PRINTED',
      },
    };
  }

  async views(requests: PrintRequest[], readerOf: (request: PrintRequest) => Reader) {
    const context = await this.context(requests);
    const now = new Date();
    return requests.map((request) => this.view(request, readerOf(request), context, now));
  }

  async eventViews(events: PrintEvent[], userId: string): Promise<PrintEventView[]> {
    const db = this.db;
    const userIds = new Set<string>();
    for (const event of events) {
      if (event.actorId) userIds.add(event.actorId);
      const metadata = (event.metadata ?? {}) as Record<string, unknown>;
      if (typeof metadata.userId === 'string') userIds.add(metadata.userId);
    }
    const requestIds = [
      ...new Set(events.flatMap((event) => (event.printRequestId ? [event.printRequestId] : []))),
    ];
    const projectIds = [
      ...new Set(events.flatMap((event) => (event.projectId ? [event.projectId] : []))),
    ];
    const [users, requests, projects] = await Promise.all([
      userIds.size
        ? db.user.findMany({
            where: { id: { in: [...userIds] } },
            select: { id: true, displayName: true },
          })
        : [],
      requestIds.length
        ? db.printRequest.findMany({
            where: { id: { in: requestIds } },
            select: { id: true, title: true },
          })
        : [],
      projectIds.length
        ? db.project.findMany({
            where: { id: { in: projectIds } },
            select: { id: true, name: true },
          })
        : [],
    ]);
    const names = new Map(users.map((user) => [user.id, user.displayName]));
    const titles = new Map(requests.map((request) => [request.id, request.title]));
    const projectNames = new Map(projects.map((project) => [project.id, project.name]));
    return events.map((event) => {
      const metadata = (event.metadata ?? {}) as Record<string, unknown>;
      return {
        id: event.id,
        type: event.type,
        actorName: event.actorId ? (names.get(event.actorId) ?? null) : null,
        mine: event.actorId === userId,
        ip: event.ip,
        createdAt: event.createdAt.toISOString(),
        requestId: event.printRequestId,
        requestTitle: event.printRequestId ? (titles.get(event.printRequestId) ?? null) : null,
        projectName: event.projectId ? (projectNames.get(event.projectId) ?? null) : null,
        details: {
          count: typeof metadata.count === 'number' ? metadata.count : null,
          to: typeof metadata.to === 'string' ? metadata.to : null,
          replaced: metadata.reason === 'replaced',
          changes: Array.isArray(metadata.changes)
            ? metadata.changes.filter((item): item is string => typeof item === 'string')
            : [],
          userName:
            typeof metadata.userId === 'string' ? (names.get(metadata.userId) ?? null) : null,
          byAuthor: metadata.byAuthor === true,
        },
      };
    });
  }
}
