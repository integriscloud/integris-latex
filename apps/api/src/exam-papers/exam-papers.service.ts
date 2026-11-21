import type { Compilation, PrintRequest, PrintSend, Prisma, User } from '@integris/db';
import {
  COMPILE_OUTPUT_BUCKET,
  type CompileIssue,
  type CompileOutcome,
  type CoeditorView,
  EXAM_PAPERS_BUCKET,
  EXAM_PART_FILES,
  type ExamGroup,
  type ExamPaperDetail,
  type ExamPaperList,
  examSubjectKey,
  PRINT_CANCELABLE,
  PRINT_EDITABLE,
  type PrintEventView,
  type PrintSendView,
  PRIVATE_EXAM_FILES,
  type ProjectSummary,
  type SendPrintRequest,
  type UpdatePrintRequest,
} from '@integris/shared';
import { HttpStatus, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from '../common/api-error.js';
import { consumeLimit } from '../common/rate-limit.js';
import { CompileService, type FrozenSource } from '../compile/compile.service.js';
import { blobKey, HistoryService } from '../history/history.service.js';
import { OrgContextService } from '../organizations/org-context.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectEventsService } from '../projects/project-events.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { isSubscriptionLive } from '../projects/quota.service.js';
import { RedisService } from '../redis/redis.service.js';
import { StorageService } from '../storage/storage.service.js';
import {
  type ExamActor,
  groupPath,
  sharedTeacherOrganization,
  teacherOrganizationIds,
  type Tx,
  writePrintEvent,
} from './exam-access.js';
import { examStarterFiles } from './exam-starter.js';
import { fail, PrintAccessService, type Reader } from './print-access.service.js';
import { pageCount } from './watermark.js';

/** Sends to the secretariat per teacher and hour (each one compiles the subject). */
const SENDS_PER_HOUR = 10;
/** Co-editor changes per exam paper and hour. */
const COEDITOR_CHANGES_PER_HOUR = 30;

/** What a send keeps until its PDF is ready (PrintSend.details). */
interface SendDetails {
  title: string;
  copies: number;
  reserveCopies: number;
  duplex: 'SIMPLEX' | 'DUPLEX';
  stapled: boolean;
  availableFrom: string;
  examAt: string;
  /** Address of the teacher when sending, for the journal. */
  ip: string | null;
}

interface StoredCompileResult {
  outcome?: CompileOutcome;
  issues?: CompileIssue[];
}

/**
 * Exam papers of teachers (docs/spec.md, "Devoirs et secrétariat", BUSINESS only): an ASSIGNMENT
 * project with its subject, answer key and marking scheme; co-editors chosen among the teachers
 * of the owner's organizations; sends to the secretariat of a class, where the project is frozen
 * and the subject alone is compiled (the answer key and marking scheme are not even given to the
 * compilation). The PDF goes to the private exam bucket and the request is created; a new send
 * replaces a request not opened yet. Every step is written to the append-only print journal.
 */
@Injectable()
export class ExamPapersService implements OnModuleInit {
  private readonly logger = new Logger(ExamPapersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly history: HistoryService,
    private readonly compile: CompileService,
    private readonly storage: StorageService,
    private readonly redis: RedisService,
    private readonly orgs: OrgContextService,
    private readonly events: ProjectEventsService,
    private readonly access: PrintAccessService,
  ) {}

  onModuleInit(): void {
    this.compile.registerFrozen('print', {
      sources: (id) => this.frozenSources(id),
      finished: (row) => this.finished(row),
    });
  }

  private get db() {
    return this.prisma.client;
  }

  // ───────────── Teachers and organizations ─────────────

  /** Live BUSINESS organizations where the user is a confirmed teacher. */
  private async liveTeacherOrganizations(userId: string): Promise<string[]> {
    const ids = await teacherOrganizationIds(this.db, userId);
    if (!ids.length) return [];
    const subscriptions = await this.db.subscription.findMany({
      where: { organizationId: { in: ids } },
    });
    const now = new Date();
    return subscriptions
      .filter((subscription) => isSubscriptionLive(subscription, now))
      .map((subscription) => subscription.organizationId!);
  }

  /** The classes a teacher can send to: groups of their live BUSINESS organizations. */
  private async groupsFor(userId: string): Promise<ExamGroup[]> {
    const organizationIds = await this.liveTeacherOrganizations(userId);
    if (!organizationIds.length) return [];
    const [organizations, groups] = await Promise.all([
      this.db.organization.findMany({ where: { id: { in: organizationIds } } }),
      this.db.orgGroup.findMany({ where: { organizationId: { in: organizationIds } } }),
    ]);
    const result: ExamGroup[] = [];
    for (const organization of organizations) {
      const own = groups.filter((group) => group.organizationId === organization.id);
      for (const group of own) {
        result.push({
          id: group.id,
          name: groupPath(own, group.id),
          organizationId: organization.id,
          organizationName: organization.name,
          secretariats: (await this.access.secretariesOf(this.db, organization.id, group.id))
            .length,
        });
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The exam paper and the user's role on it (owner or co-editor); "not found" otherwise. */
  private async paper(userId: string, projectId: string) {
    const { project, role } = await this.projects.access(userId, projectId);
    if (project.kind !== 'ASSIGNMENT') return fail(HttpStatus.NOT_FOUND, 'not_found');
    if (role !== 'OWNER' && role !== 'EDITOR') return fail(HttpStatus.NOT_FOUND, 'not_found');
    return { project, role };
  }

  private async owned(userId: string, projectId: string) {
    const found = await this.paper(userId, projectId);
    if (found.role !== 'OWNER') fail(HttpStatus.FORBIDDEN, 'forbidden');
    return found.project;
  }

  // ───────────── Exam papers ─────────────

  async list(userId: string): Promise<ExamPaperList> {
    const db = this.db;
    const [canCreate, projects] = await Promise.all([
      this.liveTeacherOrganizations(userId).then((ids) => ids.length > 0),
      db.project.findMany({
        where: {
          kind: 'ASSIGNMENT',
          deletedAt: null,
          OR: [{ ownerId: userId }, { members: { some: { userId, role: 'EDITOR' } } }],
        },
        include: { owner: { select: { displayName: true } } },
        orderBy: { lastActivityAt: 'desc' },
      }),
    ]);
    const ids = projects.map((project) => project.id);
    await this.access.promoteReady({ projectId: { in: ids } });
    const [requests, sending] = await Promise.all([
      ids.length
        ? db.printRequest.findMany({
            where: { projectId: { in: ids }, status: { not: 'CANCELED' } },
            orderBy: { createdAt: 'desc' },
          })
        : [],
      ids.length
        ? db.printSend.findMany({
            where: { projectId: { in: ids }, status: 'COMPILING' },
            select: { projectId: true },
          })
        : [],
    ]);
    const latest = new Map<string, PrintRequest>();
    for (const request of requests) {
      if (request.projectId && !latest.has(request.projectId)) {
        latest.set(request.projectId, request);
      }
    }
    const teaching = await teacherOrganizationIds(db, userId);
    const views = await this.access.views([...latest.values()], (request) =>
      this.authorReader(
        userId,
        request,
        projects.find((p) => p.id === request.projectId),
        teaching,
      ),
    );
    const viewOf = new Map(views.map((view) => [view.projectId, view]));
    const busy = new Set(sending.map((row) => row.projectId));
    return {
      canCreate,
      papers: projects.map((project) => ({
        id: project.id,
        name: project.name,
        role: project.ownerId === userId ? 'OWNER' : 'EDITOR',
        ownerName: project.owner.displayName,
        lastActivityAt: project.lastActivityAt.toISOString(),
        createdAt: project.createdAt.toISOString(),
        current: viewOf.get(project.id) ?? null,
        sending: busy.has(project.id),
      })),
    };
  }

  /**
   * The reader of a request of an exam paper the user owns or co-edits; the sender only while
   * still a teacher of the request's organization (`teaching`, PrintAccessService.reader).
   */
  private authorReader(
    userId: string,
    request: PrintRequest,
    project: { ownerId: string } | undefined,
    teaching: string[],
  ): Reader {
    return {
      userId,
      teacher: request.teacherId === userId && teaching.includes(request.organizationId),
      coeditor: project !== undefined && project.ownerId !== userId,
      secretary: false,
      admin: false,
    };
  }

  /** A new exam paper: only an active teacher of a live BUSINESS creates one. */
  async create(user: User, name: string): Promise<ProjectSummary> {
    if (!(await this.liveTeacherOrganizations(user.id)).length) {
      fail(HttpStatus.FORBIDDEN, 'exam_teacher_only');
    }
    return this.projects.createExamPaper(user, name, examStarterFiles(user.locale, name));
  }

  async detail(userId: string, projectId: string): Promise<ExamPaperDetail> {
    const { project, role } = await this.paper(userId, projectId);
    const db = this.db;
    const owner = role === 'OWNER';
    const teaching = await teacherOrganizationIds(db, userId);
    await this.access.promoteReady({ projectId });
    const [ownerUser, requests, send, members] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { id: project.ownerId } }),
      db.printRequest.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } }),
      db.printSend.findFirst({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        include: { compilation: true },
      }),
      db.projectMember.findMany({
        where: { projectId, role: 'EDITOR' },
        include: { user: { select: { id: true, displayName: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    return {
      id: project.id,
      name: project.name,
      role: owner ? 'OWNER' : 'EDITOR',
      ownerName: ownerUser.displayName,
      canSend: owner,
      groups: owner ? await this.groupsFor(userId) : [],
      send: send ? await this.sendView(send, project.ownerId) : null,
      requests: await this.access.views(requests, (request) =>
        this.authorReader(userId, request, project, teaching),
      ),
      coeditors: await this.coeditorViews(
        project.ownerId,
        members.map((member) => member.user),
      ),
      candidates: owner ? await this.candidates(project.ownerId, projectId) : [],
    };
  }

  private async coeditorViews(
    ownerId: string,
    users: { id: string; displayName: string }[],
  ): Promise<CoeditorView[]> {
    const views: CoeditorView[] = [];
    for (const user of users) {
      const organizationId = await sharedTeacherOrganization(this.db, ownerId, user.id);
      const organization = organizationId
        ? await this.db.organization.findUnique({ where: { id: organizationId } })
        : null;
      views.push({
        userId: user.id,
        name: user.displayName,
        organizationName: organization?.name ?? '',
      });
    }
    return views;
  }

  /** Confirmed teachers of the owner's BUSINESS organizations, not co-editors yet. */
  private async candidates(ownerId: string, projectId: string): Promise<CoeditorView[]> {
    const organizationIds = await teacherOrganizationIds(this.db, ownerId);
    if (!organizationIds.length) return [];
    const [teachers, members] = await Promise.all([
      this.db.membership.findMany({
        where: {
          organizationId: { in: organizationIds },
          status: 'ACTIVE',
          kind: 'TEACHER',
          userId: { not: ownerId },
        },
        include: {
          user: { select: { id: true, displayName: true } },
          organization: { select: { name: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.db.projectMember.findMany({ where: { projectId }, select: { userId: true } }),
    ]);
    const taken = new Set(members.map((member) => member.userId));
    const seen = new Set<string>();
    const result: CoeditorView[] = [];
    for (const teacher of teachers) {
      if (taken.has(teacher.userId) || seen.has(teacher.userId)) continue;
      seen.add(teacher.userId);
      result.push({
        userId: teacher.user.id,
        name: teacher.user.displayName,
        organizationName: teacher.organization.name,
      });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Journal of the exam paper: its requests and its co-editors (owner and co-editors). */
  async journal(userId: string, projectId: string): Promise<PrintEventView[]> {
    await this.paper(userId, projectId);
    const events = await this.db.printEvent.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return this.access.eventViews(events, userId);
  }

  // ───────────── Co-editors ─────────────

  /**
   * Adds a co-editor (Editor role, no invitation): a confirmed teacher of an organization where
   * the owner is a teacher too (step 13 decisions). Audit log and journal of the exam paper.
   */
  async addCoeditor(actor: ExamActor & { userId: string }, projectId: string, userId: string) {
    const project = await this.owned(actor.userId, projectId);
    if (userId === actor.userId) fail(HttpStatus.CONFLICT, 'coeditor_invalid');
    await consumeLimit(
      this.redis.client,
      `rl:exam-coeditor:${projectId}`,
      COEDITOR_CHANGES_PER_HOUR,
      3600,
    );
    const organizationId = await sharedTeacherOrganization(this.db, project.ownerId, userId);
    if (!organizationId) return fail(HttpStatus.CONFLICT, 'coeditor_invalid');
    await this.orgs.locked(organizationId, () =>
      this.db.$transaction(async (tx) => {
        // Checked again under the lock: a departure or a profile change cannot slip in between.
        if (!(await sharedTeacherOrganization(tx, project.ownerId, userId))) {
          return fail(HttpStatus.CONFLICT, 'coeditor_invalid');
        }
        const existing = await tx.projectMember.findUnique({
          where: { projectId_userId: { projectId, userId } },
        });
        if (existing) return fail(HttpStatus.CONFLICT, 'coeditor_invalid');
        await tx.projectMember.create({ data: { projectId, userId, role: 'EDITOR' } });
        await tx.auditLog.create({
          data: {
            actorId: actor.userId,
            action: 'PROJECT_SHARED',
            targetType: 'Project',
            targetId: projectId,
            metadata: { userId, role: 'EDITOR', examPaper: true, organizationId },
            ip: actor.ip,
          },
        });
        await writePrintEvent(tx, actor, {
          type: 'COEDITOR_ADDED',
          projectId,
          organizationId,
          metadata: { userId },
        });
      }),
    );
    return this.detail(actor.userId, projectId);
  }

  async removeCoeditor(actor: ExamActor & { userId: string }, projectId: string, userId: string) {
    const project = await this.owned(actor.userId, projectId);
    await this.db.$transaction(async (tx) => {
      const member = await tx.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId } },
      });
      if (!member || member.role !== 'EDITOR') return fail(HttpStatus.NOT_FOUND, 'not_found');
      await tx.projectMember.delete({ where: { id: member.id } });
      const organizationId = await sharedTeacherOrganization(tx, project.ownerId, userId);
      await tx.auditLog.create({
        data: {
          actorId: actor.userId,
          action: 'PROJECT_ACCESS_REMOVED',
          targetType: 'Project',
          targetId: projectId,
          metadata: { userId, role: 'EDITOR', examPaper: true },
          ip: actor.ip,
        },
      });
      await writePrintEvent(tx, actor, {
        type: 'COEDITOR_REMOVED',
        projectId,
        organizationId,
        metadata: { userId, reason: 'removed_by_owner' },
      });
    });
    // Open editors of the former co-editor are disconnected.
    await this.events.publish({ type: 'project-access', projectId });
    return this.detail(actor.userId, projectId);
  }

  // ───────────── Sending ─────────────

  /** Checks of a class and dates for a teacher's request; returns the organization. */
  private async checkTarget(
    teacherId: string,
    fields: { groupId: string; availableFrom: Date; examAt: Date },
    now = new Date(),
  ): Promise<string> {
    const group = await this.db.orgGroup.findUnique({ where: { id: fields.groupId } });
    const organizations = await this.liveTeacherOrganizations(teacherId);
    if (!group) return fail(HttpStatus.NOT_FOUND, 'group_not_found');
    if (!organizations.includes(group.organizationId)) {
      return fail(HttpStatus.FORBIDDEN, 'exam_teacher_only');
    }
    if (!(fields.availableFrom < fields.examAt) || !(fields.examAt > now)) {
      fail(HttpStatus.BAD_REQUEST, 'exam_dates_invalid');
    }
    const secretaries = await this.access.secretariesOf(
      this.db,
      group.organizationId,
      fields.groupId,
    );
    if (!secretaries.length) fail(HttpStatus.CONFLICT, 'no_secretariat');
    return group.organizationId;
  }

  /**
   * Sends the subject to the secretariat: the project is frozen (history version kept whatever the
   * plan), the subject alone is compiled, and the request is created when its PDF is ready. Only
   * the owner sends (step 13 decisions); `replacesId` names a request not opened yet.
   */
  async send(
    actor: ExamActor & { userId: string },
    projectId: string,
    body: SendPrintRequest,
  ): Promise<ExamPaperDetail> {
    const project = await this.owned(actor.userId, projectId);
    const availableFrom = new Date(body.availableFrom);
    const examAt = new Date(body.examAt);
    const organizationId = await this.checkTarget(actor.userId, {
      groupId: body.groupId,
      availableFrom,
      examAt,
    });
    if (body.replacesId) {
      const replaced = await this.db.printRequest.findFirst({
        where: { id: body.replacesId, projectId, teacherId: actor.userId },
      });
      if (!replaced) return fail(HttpStatus.NOT_FOUND, 'print_not_found');
      if (!PRINT_EDITABLE.includes(replaced.status)) fail(HttpStatus.CONFLICT, 'print_status');
    }
    const subject = await this.db.projectFile.findUnique({
      where: { projectId_path: { projectId, path: EXAM_PART_FILES.subject } },
    });
    if (!subject) fail(HttpStatus.CONFLICT, 'main_missing');
    await consumeLimit(this.redis.client, `rl:print-send:${actor.userId}`, SENDS_PER_HOUR, 3600);
    const details: SendDetails = {
      title: body.title,
      copies: body.copies,
      reserveCopies: body.reserveCopies,
      duplex: body.duplex,
      stapled: body.stapled,
      availableFrom: availableFrom.toISOString(),
      examAt: examAt.toISOString(),
      ip: actor.ip,
    };
    // One send at a time per exam paper, checked and written under the owner's lock.
    const send = await this.projects.runLocked(project.ownerId, async () => {
      const pending = await this.db.printSend.findFirst({
        where: { projectId, status: 'COMPILING' },
        include: { compilation: true },
      });
      if (pending && (await this.sendView(pending, project.ownerId)).status === 'COMPILING') {
        fail(HttpStatus.CONFLICT, 'exam_send_pending');
      }
      return this.db.printSend.create({
        data: {
          projectId,
          teacherId: actor.userId,
          organizationId,
          groupId: body.groupId,
          details: details as unknown as Prisma.InputJsonObject,
          replacesId: body.replacesId ?? null,
        },
      });
    });
    try {
      const frozen = await this.history.createVersion(projectId, 'PRINT', {
        userId: actor.userId,
      });
      if (!frozen) return fail(HttpStatus.NOT_FOUND, 'not_found');
      await this.db.printSend.update({ where: { id: send.id }, data: { versionId: frozen.id } });
      const manifest = await this.history.readManifest(frozen);
      await this.compile.startFrozen({
        projectId,
        ownerId: project.ownerId,
        userId: actor.userId,
        engine: project.engine,
        frozen: { printSendId: send.id },
        mainFile: EXAM_PART_FILES.subject,
        files: this.subjectSources(projectId, manifest.files),
      });
    } catch (error) {
      await this.db.printSend.update({
        where: { id: send.id },
        data: {
          status: 'FAILED',
          errors: { reason: error instanceof ApiError ? codeOf(error) : 'compile_unavailable' },
        },
      });
      throw error;
    }
    return this.detail(actor.userId, projectId);
  }

  /**
   * Sources of the subject: every frozen file but the answer key and the marking scheme, which
   * never leave the project (a subject that includes them fails to compile).
   */
  private subjectSources(
    projectId: string,
    files: { path: string; blob: string | null; sizeBytes: number }[],
  ): FrozenSource[] {
    return files.flatMap((file) =>
      file.blob && !PRIVATE_EXAM_FILES.includes(file.path)
        ? [
            {
              path: file.path,
              storageKey: blobKey(projectId, file.blob),
              sizeBytes: file.sizeBytes,
            },
          ]
        : [],
    );
  }

  /** Sources of a queued compilation of a send (URLs signed again). */
  private async frozenSources(printSendId: string) {
    const send = await this.db.printSend.findUnique({ where: { id: printSendId } });
    if (!send || send.status !== 'COMPILING' || !send.versionId) return null;
    const version = await this.db.projectVersion.findUnique({ where: { id: send.versionId } });
    // Defence in depth: only history objects of the send's own project are signed.
    if (!version || version.projectId !== send.projectId) return null;
    const manifest = await this.history.readManifest(version);
    return {
      mainFile: EXAM_PART_FILES.subject,
      files: this.subjectSources(send.projectId, manifest.files),
    };
  }

  /** What the app shows of a send; a compilation whose worker event was missed is finished. */
  private async sendView(
    send: PrintSend & { compilation: Compilation | null },
    ownerId: string,
  ): Promise<PrintSendView> {
    let current = send;
    if (send.status === 'COMPILING' && send.compilation) {
      const row = await this.compile.refreshFrozen(send.compilation, ownerId);
      if (row.status !== send.compilation.status) {
        current = await this.db.printSend.findUniqueOrThrow({
          where: { id: send.id },
          include: { compilation: true },
        });
      }
    }
    const errors = (current.errors ?? {}) as {
      reason?: string;
      outcome?: CompileOutcome;
      issues?: CompileIssue[];
    };
    return {
      id: current.id,
      status: current.status,
      outcome: errors.outcome ?? null,
      issues: (errors.issues ?? []).slice(0, 3),
      reason: errors.reason ?? null,
      createdAt: current.createdAt.toISOString(),
    };
  }

  /**
   * The compilation of a send finished: with a PDF, the subject moves to the private exam
   * bucket and the request is created (replacing the one named, if it is still not opened);
   * without, the send fails with the errors. The compile outputs are always deleted.
   */
  private async finished(row: Compilation): Promise<void> {
    const send = row.printSendId
      ? await this.db.printSend.findUnique({ where: { id: row.printSendId } })
      : null;
    try {
      if (!send || send.status !== 'COMPILING') return;
      const stored = (row.errors ?? {}) as StoredCompileResult;
      if (!row.pdfKey) {
        await this.db.printSend.updateMany({
          where: { id: send.id, status: 'COMPILING' },
          data: {
            status: 'FAILED',
            errors: {
              outcome: stored.outcome ?? 'internal',
              issues: (stored.issues ?? []).slice(0, 3),
            } as unknown as Prisma.InputJsonObject,
          },
        });
        return;
      }
      const pdf = await this.storage.get(COMPILE_OUTPUT_BUCKET, row.pdfKey);
      await this.createRequest(send, pdf);
    } catch (error) {
      this.logger.error({ err: (error as Error).message, sendId: send?.id }, 'Print send failed');
      await this.db.printSend
        .updateMany({
          where: { id: send!.id, status: 'COMPILING' },
          data: { status: 'FAILED', errors: { reason: codeOf(error) ?? 'internal' } },
        })
        .catch(() => undefined);
    } finally {
      await this.compile
        .dropOutputs(row.projectId, row.id)
        .catch((error: unknown) =>
          this.logger.error({ err: (error as Error).message, id: row.id }, 'Outputs not deleted'),
        );
    }
  }

  private async createRequest(send: PrintSend, pdf: Uint8Array): Promise<void> {
    const details = send.details as unknown as SendDetails;
    const requestId = randomUUID();
    const key = examSubjectKey(send.organizationId, requestId);
    const pages = await pageCount(pdf);
    const sha256 = createHash('sha256').update(pdf).digest('hex');
    await this.storage.put(EXAM_PAPERS_BUCKET, key, pdf);
    const actor: ExamActor = { userId: send.teacherId, ip: details.ip };
    const now = new Date();
    const availableFrom = new Date(details.availableFrom);
    try {
      const request = await this.db.$transaction(async (tx) => {
        if (send.replacesId) {
          const { count } = await tx.printRequest.updateMany({
            where: { id: send.replacesId, status: { in: [...PRINT_EDITABLE] } },
            data: { status: 'CANCELED', canceledAt: now, replacedById: requestId },
          });
          // Opened meanwhile: the teacher must cancel it and send again.
          if (!count) return fail(HttpStatus.CONFLICT, 'print_status');
        }
        const created = await tx.printRequest.create({
          data: {
            id: requestId,
            organizationId: send.organizationId,
            projectId: send.projectId,
            teacherId: send.teacherId,
            groupId: send.groupId,
            title: details.title,
            subjectPdfKey: key,
            subjectSha256: sha256,
            pages,
            copies: details.copies,
            reserveCopies: details.reserveCopies,
            duplex: details.duplex,
            stapled: details.stapled,
            availableFrom,
            examAt: new Date(details.examAt),
            status: availableFrom <= now ? 'READY' : 'SCHEDULED',
          },
        });
        if (send.replacesId) {
          await writePrintEvent(tx, actor, {
            type: 'CANCELED',
            projectId: send.projectId,
            organizationId: send.organizationId,
            printRequestId: send.replacesId,
            metadata: { reason: 'replaced', replacedById: requestId },
          });
        }
        await writePrintEvent(tx, actor, {
          type: 'REQUESTED',
          projectId: send.projectId,
          organizationId: send.organizationId,
          printRequestId: requestId,
          metadata: {
            sha256,
            pages,
            versionId: send.versionId,
            ...(send.replacesId ? { replaces: send.replacesId } : {}),
          },
        });
        const { count } = await tx.printSend.updateMany({
          where: { id: send.id, status: 'COMPILING' },
          data: { status: 'DONE', printRequestId: requestId },
        });
        if (!count) throw new Error('Send finished twice');
        if (created.status === 'READY') await this.access.notifyReady(tx, created);
        return created;
      });
      this.logger.log({ requestId: request.id }, 'Print request created');
    } catch (error) {
      await this.storage.deleteKeys(EXAM_PAPERS_BUCKET, [key]).catch(() => undefined);
      throw error;
    }
  }

  // ───────────── Changes before opening ─────────────

  /** Changes a request not opened yet (owner only); a later date locks it again. */
  async update(
    actor: ExamActor & { userId: string },
    requestId: string,
    body: UpdatePrintRequest,
  ): Promise<ExamPaperDetail> {
    const { request, reader } = await this.access.load(actor.userId, requestId);
    if (!reader.teacher || !request.projectId) return fail(HttpStatus.FORBIDDEN, 'forbidden');
    if (!PRINT_EDITABLE.includes(request.status)) fail(HttpStatus.CONFLICT, 'print_status');
    const next = {
      title: body.title ?? request.title,
      groupId: body.groupId ?? request.groupId,
      copies: body.copies ?? request.copies,
      reserveCopies: body.reserveCopies ?? request.reserveCopies,
      duplex: body.duplex ?? request.duplex,
      stapled: body.stapled ?? request.stapled,
      availableFrom: body.availableFrom ? new Date(body.availableFrom) : request.availableFrom,
      examAt: body.examAt ? new Date(body.examAt) : request.examAt,
    };
    const organizationId = await this.checkTarget(actor.userId, next);
    // The class stays in the organization the subject was sent to.
    if (organizationId !== request.organizationId) fail(HttpStatus.CONFLICT, 'group_not_found');
    const changes = (Object.keys(next) as (keyof typeof next)[]).filter((field) => {
      const before = request[field];
      const after = next[field];
      return before instanceof Date
        ? before.getTime() !== (after as Date).getTime()
        : before !== after;
    });
    if (!changes.length) return this.detail(actor.userId, request.projectId);
    const now = new Date();
    const status = next.availableFrom <= now ? 'READY' : 'SCHEDULED';
    await this.db.$transaction(async (tx) => {
      const { count } = await tx.printRequest.updateMany({
        where: { id: request.id, status: { in: [...PRINT_EDITABLE] } },
        data: { ...next, status },
      });
      if (!count) return fail(HttpStatus.CONFLICT, 'print_status');
      await writePrintEvent(tx, actor, {
        type: 'UPDATED',
        projectId: request.projectId,
        organizationId: request.organizationId,
        printRequestId: request.id,
        metadata: {
          changes,
          before: Object.fromEntries(changes.map((field) => [field, jsonValue(request[field])])),
          after: Object.fromEntries(changes.map((field) => [field, jsonValue(next[field])])),
        },
      });
      if (status === 'READY') {
        await this.access.notifyReady(tx, { ...request, ...next, status });
      }
    });
    return this.detail(actor.userId, request.projectId);
  }

  /** Cancels a request until its copies are handed over (owner only). */
  async cancel(actor: ExamActor & { userId: string }, requestId: string) {
    const { request, reader } = await this.access.load(actor.userId, requestId);
    if (!reader.teacher) return fail(HttpStatus.FORBIDDEN, 'forbidden');
    await this.db.$transaction(async (tx) => {
      const { count } = await tx.printRequest.updateMany({
        where: { id: request.id, status: { in: [...PRINT_CANCELABLE] } },
        data: { status: 'CANCELED', canceledAt: new Date() },
      });
      if (!count) return fail(HttpStatus.CONFLICT, 'print_status');
      await writePrintEvent(tx, actor, {
        type: 'CANCELED',
        projectId: request.projectId,
        organizationId: request.organizationId,
        printRequestId: request.id,
        metadata: { status: request.status },
      });
    });
    return request.projectId ? this.detail(actor.userId, request.projectId) : null;
  }
}

function jsonValue(value: unknown): string | number | boolean | null {
  if (value instanceof Date) return value.toISOString();
  return value as string | number | boolean | null;
}

function codeOf(error: unknown): string | null {
  return error instanceof ApiError ? (error.getResponse() as { code: string }).code : null;
}

export type { Tx };
