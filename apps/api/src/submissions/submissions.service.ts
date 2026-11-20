import type {
  Compilation as CompilationRow,
  Prisma,
  Project,
  ProjectRole,
  SubmissionStatus,
} from '@integris/db';
import {
  type Compilation,
  type createSubmissionSchema,
  diffTexts,
  DIFF_CONTEXT_LINES,
  type FileComparison,
  pathConflicts,
  PROJECTS_BUCKET,
  REVIEWER_ROLES,
  SUBMISSION_ACTIONS,
  SUBMISSION_SENDS_PER_HOUR,
  type sendSubmissionSchema,
  type SubmissionAction,
  type SubmissionComparison,
  type SubmissionDetail,
  type SubmissionEvent,
  type SubmissionFileHash,
  type SubmissionList,
  type SubmissionSummary,
  TO_REVIEW_STATUSES,
  type ToReviewList,
  type UpdateSubmissionRequest,
} from '@integris/shared';
import { HttpStatus, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { ApiError } from '../common/api-error.js';
import { consumeLimit } from '../common/rate-limit.js';
import { ApiConfig } from '../config/api-config.js';
import { CompileService, type FrozenSource } from '../compile/compile.service.js';
import { blobKey, blobOf, HistoryService, type Manifest } from '../history/history.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectEventsService } from '../projects/project-events.service.js';
import { fail, type ProjectAccess, ProjectsService } from '../projects/projects.service.js';
import { RedisService } from '../redis/redis.service.js';
import { StorageService } from '../storage/storage.service.js';

const HOUR_SECONDS = 3600;
/** A sending without compilation this long after it was made was left behind by a crash. */
const ORPHAN_SENDING_MS = 60_000;
/** Comparisons per user and per minute (each one reads and compares whole files). */
const COMPARES_PER_MINUTE = 20;
/** Text compared line by line in one comparison at most; beyond, files show "too large". */
const COMPARE_BUDGET_BYTES = 4 * 1024 * 1024;
const decoder = new TextDecoder();

/** Label of the version saved when a validation puts the submitted files back (owner's language). */
export const BEFORE_VALIDATION_LABEL = { fr: 'Avant validation', en: 'Before validation' } as const;

const person = { select: { id: true, displayName: true } } as const;

const INCLUDE = {
  author: person,
  reviewers: { include: { reviewer: person }, orderBy: { id: 'asc' } },
  versions: { include: { sentBy: person, compilation: true }, orderBy: { createdAt: 'desc' } },
} satisfies Prisma.SubmissionInclude;

/** For lists: the newest sending being compiled and the last one ready are enough. */
const SUMMARY_INCLUDE = {
  author: person,
  reviewers: { include: { reviewer: person }, orderBy: { id: 'asc' } },
  versions: {
    where: { state: { in: ['READY', 'COMPILING'] } },
    orderBy: { createdAt: 'desc' },
    take: 2,
  },
} satisfies Prisma.SubmissionInclude;

type SubmissionRow = Prisma.SubmissionGetPayload<{ include: typeof INCLUDE }>;
type SummaryRow = Prisma.SubmissionGetPayload<{ include: typeof SUMMARY_INCLUDE }>;
type VersionRow = SubmissionRow['versions'][number];

/** Who acts, from where (for the audit entries). */
export interface SubmissionActor {
  userId: string;
  ip: string | null;
}

const personOf = (user: { id: string; displayName: string }) => ({
  id: user.id,
  name: user.displayName,
});

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const isReviewerRole = (role: ProjectRole | null): boolean =>
  role !== null && (REVIEWER_ROLES as readonly string[]).includes(role);

/**
 * Submissions to supervisors (docs/spec.md, "Encadrement"). The owner and editors prepare a
 * draft (title, files, message, deadline, reviewers among the project's supervisors and
 * reviewers) and send it: the project is frozen as a version and that version is compiled on its
 * own, so reviewers always read the PDF of what was sent, never the project's last PDF. Without a
 * PDF the sending is refused. Statuses: DRAFT → SUBMITTED → IN_REVIEW → FEEDBACK_SENT → REVISED
 * (a corrected version, v2…) → IN_REVIEW … → VALIDATED. Only a supervisor among the reviewers
 * validates: the files sent are put back as validated, locked, and the trace of the validation
 * (metadata and SHA-256 only) outlives the project. Every sending, status change, validation,
 * unlocking and deadline change writes an audit entry in the same transaction.
 */
@Injectable()
export class SubmissionsService implements OnModuleInit {
  private readonly logger = new Logger(SubmissionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly history: HistoryService,
    private readonly compile: CompileService,
    private readonly storage: StorageService,
    private readonly redis: RedisService,
    private readonly events: ProjectEventsService,
    private readonly config: ApiConfig,
  ) {}

  onModuleInit(): void {
    this.compile.registerFrozen({
      sources: (id) => this.frozenSources(id),
      finished: (row) => this.compiled(row),
    });
  }

  // ───────────── Access ─────────────

  private async load(
    userId: string,
    projectId: string,
    submissionId: string,
  ): Promise<{ access: ProjectAccess; submission: SubmissionRow }> {
    const access = await this.projects.access(userId, projectId);
    const submission = await this.prisma.client.submission.findFirst({
      where: { id: submissionId, projectId },
      include: INCLUDE,
    });
    if (!submission) return fail(HttpStatus.NOT_FOUND, 'not_found');
    return { access, submission };
  }

  /** Current roles of the reviewers on the project (null once their access was removed). */
  private async rolesOf(project: Project, userIds: string[]): Promise<Map<string, ProjectRole>> {
    if (!userIds.length) return new Map();
    const members = await this.prisma.client.projectMember.findMany({
      where: { projectId: project.id, userId: { in: userIds } },
    });
    return new Map(members.map((member) => [member.userId, member.role]));
  }

  private async audit(
    tx: Prisma.TransactionClient,
    actor: SubmissionActor,
    action: SubmissionAction,
    submission: { id: string; projectId: string },
    metadata: Prisma.InputJsonObject = {},
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorId: actor.userId,
        action,
        targetType: 'Submission',
        targetId: submission.id,
        metadata: { projectId: submission.projectId, ...metadata },
        ip: actor.ip,
      },
    });
  }

  /**
   * Moves a submission from one status to another, only if it is still in `from` (two people
   * acting at once: the second gets `submission_state`), with its audit entry.
   */
  private async move(
    tx: Prisma.TransactionClient,
    actor: SubmissionActor,
    submission: { id: string; projectId: string },
    from: SubmissionStatus[],
    data: Prisma.SubmissionUpdateManyMutationInput & { status: SubmissionStatus },
    action: SubmissionAction,
    metadata: Prisma.InputJsonObject = {},
  ): Promise<void> {
    const moved = await tx.submission.updateMany({
      where: { id: submission.id, status: { in: from } },
      data,
    });
    if (!moved.count) fail(HttpStatus.CONFLICT, 'submission_state');
    await this.audit(tx, actor, action, submission, { status: data.status, ...metadata });
  }

  // ───────────── Drafts ─────────────

  /** Checks the reviewers chosen: supervisors or reviewers of the project, none twice. */
  private async checkReviewers(project: Project, reviewerIds: string[]): Promise<string[]> {
    const unique = [...new Set(reviewerIds)];
    const roles = await this.rolesOf(project, unique);
    if (unique.some((id) => !isReviewerRole(roles.get(id) ?? null))) {
      fail(HttpStatus.UNPROCESSABLE_ENTITY, 'reviewer_invalid');
    }
    return unique;
  }

  /** Checks the files chosen: paths of the project, none twice. */
  private async checkFiles(projectId: string, filePaths: string[]): Promise<string[]> {
    const unique = [...new Set(filePaths)];
    if (!unique.length) return unique;
    const found = await this.prisma.client.projectFile.count({
      where: { projectId, path: { in: unique } },
    });
    if (found !== unique.length) fail(HttpStatus.UNPROCESSABLE_ENTITY, 'files_invalid');
    return unique;
  }

  async create(
    userId: string,
    projectId: string,
    body: z.output<typeof createSubmissionSchema>,
  ): Promise<SubmissionDetail> {
    const { project } = await this.projects.require(userId, projectId, 'edit');
    const reviewerIds = await this.checkReviewers(project, body.reviewerIds);
    const filePaths = await this.checkFiles(projectId, body.filePaths);
    const created = await this.prisma.client.submission.create({
      data: {
        projectId,
        authorId: userId,
        title: body.title,
        filePaths,
        message: body.message,
        dueAt: body.dueAt ? new Date(body.dueAt) : null,
        reviewers: { create: reviewerIds.map((reviewerId) => ({ reviewerId })) },
      },
    });
    return this.detail(userId, projectId, created.id);
  }

  /** A draft the user may change: owner or editor, nothing being sent. */
  private async draft(userId: string, projectId: string, submissionId: string) {
    const { project } = await this.projects.require(userId, projectId, 'edit');
    let { access, submission } = await this.load(userId, projectId, submissionId);
    if (await this.reconcile(submission, project.ownerId)) {
      ({ access, submission } = await this.load(userId, projectId, submissionId));
    }
    if (submission.status !== 'DRAFT') fail(HttpStatus.CONFLICT, 'submission_state');
    if (submission.versions.some((version) => version.state === 'COMPILING')) {
      fail(HttpStatus.CONFLICT, 'submission_busy');
    }
    return { project, access, submission };
  }

  async update(
    userId: string,
    projectId: string,
    submissionId: string,
    body: UpdateSubmissionRequest,
  ): Promise<SubmissionDetail> {
    const { project } = await this.draft(userId, projectId, submissionId);
    const db = this.prisma.client;
    const reviewerIds =
      body.reviewerIds !== undefined ? await this.checkReviewers(project, body.reviewerIds) : null;
    const filePaths =
      body.filePaths !== undefined ? await this.checkFiles(projectId, body.filePaths) : undefined;
    await db.$transaction(async (tx) => {
      const changed = await tx.submission.updateMany({
        where: { id: submissionId, status: 'DRAFT' },
        data: {
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(filePaths !== undefined ? { filePaths } : {}),
          ...(body.message !== undefined ? { message: body.message } : {}),
          ...(body.dueAt !== undefined ? { dueAt: body.dueAt ? new Date(body.dueAt) : null } : {}),
        },
      });
      if (!changed.count) fail(HttpStatus.CONFLICT, 'submission_state');
      if (reviewerIds) {
        await tx.submissionReviewer.deleteMany({
          where: { submissionId, reviewerId: { notIn: reviewerIds } },
        });
        const kept = await tx.submissionReviewer.findMany({ where: { submissionId } });
        const known = new Set(kept.map((item) => item.reviewerId));
        const added = reviewerIds.filter((id) => !known.has(id));
        if (added.length) {
          await tx.submissionReviewer.createMany({
            data: added.map((reviewerId) => ({ submissionId, reviewerId })),
          });
        }
      }
    });
    return this.detail(userId, projectId, submissionId);
  }

  /** Deletes a draft never sent with success (its failed sendings and their outputs go too). */
  async remove(userId: string, projectId: string, submissionId: string): Promise<void> {
    const { submission } = await this.draft(userId, projectId, submissionId);
    const db = this.prisma.client;
    const versionIds = submission.versions.map((version) => version.id);
    const compilations = submission.versions.flatMap((version) =>
      version.compilation ? [version.compilation.id] : [],
    );
    for (const id of compilations) {
      await this.compile.dropOutputs(projectId, id);
    }
    await db.$transaction([
      db.compilation.deleteMany({ where: { id: { in: compilations } } }),
      db.submissionVersion.deleteMany({ where: { id: { in: versionIds } } }),
      db.submissionReviewer.deleteMany({ where: { submissionId } }),
      db.submission.deleteMany({ where: { id: submissionId, status: 'DRAFT' } }),
    ]);
  }

  // ───────────── Sending ─────────────

  /**
   * Sends the draft (v1) or a corrected version after feedback: freezes the project as a
   * version, records the SHA-256 of the files chosen, and compiles that version. The status moves
   * on only when its PDF is ready (`compiled`); without a PDF the sending is refused.
   * SUBMISSION_SENDS_PER_HOUR sendings per project and per hour.
   */
  async send(
    actor: SubmissionActor,
    projectId: string,
    submissionId: string,
    body: z.output<typeof sendSubmissionSchema>,
  ): Promise<SubmissionDetail> {
    const { project } = await this.projects.require(actor.userId, projectId, 'edit');
    let { submission } = await this.load(actor.userId, projectId, submissionId);
    if (await this.reconcile(submission, project.ownerId)) {
      ({ submission } = await this.load(actor.userId, projectId, submissionId));
    }
    if (submission.status !== 'DRAFT' && submission.status !== 'FEEDBACK_SENT') {
      fail(HttpStatus.CONFLICT, 'submission_state');
    }
    if (submission.versions.some((version) => version.state === 'COMPILING')) {
      fail(HttpStatus.CONFLICT, 'submission_busy');
    }
    const roles = await this.rolesOf(
      project,
      submission.reviewers.map((item) => item.reviewerId),
    );
    if (![...roles.values()].some((role) => isReviewerRole(role))) {
      fail(HttpStatus.UNPROCESSABLE_ENTITY, 'no_reviewer');
    }
    const filePaths = await this.checkFiles(projectId, body.filePaths);
    if (!filePaths.length) fail(HttpStatus.UNPROCESSABLE_ENTITY, 'files_invalid');
    const main = await this.prisma.client.projectFile.findFirst({
      where: { projectId, path: project.mainFilePath },
    });
    if (!main || !main.path.toLowerCase().endsWith('.tex')) {
      fail(HttpStatus.UNPROCESSABLE_ENTITY, 'main_missing');
    }
    await consumeLimit(
      this.redis.client,
      `rl:submission-send:${projectId}`,
      SUBMISSION_SENDS_PER_HOUR,
      HOUR_SECONDS,
    );
    // And per account (the owner, charged for the compilation), across all their projects.
    try {
      await consumeLimit(
        this.redis.client,
        `rl:submission-compile:${project.ownerId}`,
        this.config.env.SUBMISSION_COMPILES_PER_HOUR,
        HOUR_SECONDS,
      );
    } catch (error) {
      const retryAfter = (error as { getResponse?: () => { retryAfter?: number } }).getResponse?.()
        ?.retryAfter;
      throw new ApiError(HttpStatus.TOO_MANY_REQUESTS, 'submission_compile_limit', retryAfter);
    }

    const frozen = await this.history.createVersion(projectId, 'SUBMISSION', {
      userId: actor.userId,
      label: submission.title,
    });
    if (!frozen) return fail(HttpStatus.NOT_FOUND, 'not_found');
    const manifest = await this.history.readManifest(frozen);
    const files: SubmissionFileHash[] = [];
    for (const path of filePaths) {
      const file = manifest.files.find((item) => item.path === path);
      // Deleted between the check and the version.
      if (!file) return fail(HttpStatus.UNPROCESSABLE_ENTITY, 'files_invalid');
      const bytes = file.blob
        ? await this.storage.get(PROJECTS_BUCKET, blobKey(projectId, file.blob))
        : new Uint8Array();
      files.push({ path, sha256: sha256(bytes) });
    }

    const db = this.prisma.client;
    let versionId: string;
    try {
      const version = await db.submissionVersion.create({
        data: {
          submissionId,
          projectVersionId: frozen.id,
          filePaths,
          message: body.message,
          files: files as unknown as Prisma.InputJsonArray,
          sentById: actor.userId,
          sentIp: actor.ip,
        },
      });
      versionId = version.id;
    } catch (error) {
      // Partial unique index: another sending of this submission is being compiled.
      // The frozen version taken for it becomes an ordinary one of the history.
      await this.prisma.client.projectVersion
        .update({ where: { id: frozen.id }, data: { kind: 'AUTO', label: null } })
        .catch(() => undefined);
      if ((error as { code?: string }).code === 'P2002')
        fail(HttpStatus.CONFLICT, 'submission_busy');
      throw error;
    }
    await db.submission.update({
      where: { id: submissionId },
      data: { filePaths, message: body.message },
    });
    try {
      await this.compile.startFrozen({
        projectId,
        ownerId: project.ownerId,
        userId: actor.userId,
        engine: project.engine,
        submissionVersionId: versionId,
        mainFile: manifest.mainFilePath,
        files: this.sourcesOf(projectId, manifest),
      });
    } catch (error) {
      await this.refuse(versionId, frozen.id);
      throw error;
    }
    return this.detail(actor.userId, projectId, submissionId);
  }

  private sourcesOf(projectId: string, manifest: Manifest): FrozenSource[] {
    return manifest.files.flatMap((file) =>
      file.blob
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

  /** Sources of a queued compilation of a submission version (URLs signed again). */
  private async frozenSources(submissionVersionId: string) {
    const version = await this.prisma.client.submissionVersion.findUnique({
      where: { id: submissionVersionId },
      include: { projectVersion: true },
    });
    if (!version || version.state !== 'COMPILING') return null;
    const compilation = await this.prisma.client.compilation.findUnique({
      where: { submissionVersionId },
    });
    // Defence in depth: only history objects of the compilation's own project are signed.
    if (!compilation || compilation.projectId !== version.projectVersion.projectId) return null;
    const manifest = await this.history.readManifest(version.projectVersion);
    return {
      mainFile: manifest.mainFilePath,
      files: this.sourcesOf(version.projectVersion.projectId, manifest),
    };
  }

  /**
   * A sending without PDF: refused. The submission keeps its status (draft, or feedback sent)
   * and the sender sees the errors; the frozen version becomes an ordinary one of the history.
   */
  private async refuse(versionId: string, projectVersionId: string): Promise<void> {
    const db = this.prisma.client;
    await db.submissionVersion.updateMany({
      where: { id: versionId, state: 'COMPILING' },
      data: { state: 'FAILED' },
    });
    await db.projectVersion.update({
      where: { id: projectVersionId },
      data: { kind: 'AUTO', label: null },
    });
  }

  /** The compilation of a sending finished: the submission moves on, or the sending is refused. */
  private async compiled(row: CompilationRow): Promise<void> {
    if (!row.submissionVersionId) return;
    const db = this.prisma.client;
    const version = await db.submissionVersion.findUnique({
      where: { id: row.submissionVersionId },
      include: { submission: true },
    });
    if (!version || version.state !== 'COMPILING') return;
    if (!row.pdfKey) {
      await this.refuse(version.id, version.projectVersionId);
      return;
    }
    const { submission } = version;
    const next: SubmissionStatus = submission.status === 'DRAFT' ? 'SUBMITTED' : 'REVISED';
    const now = new Date();
    await db.$transaction(async (tx) => {
      const number =
        (await tx.submissionVersion.count({
          where: { submissionId: submission.id, state: 'READY' },
        })) + 1;
      const ready = await tx.submissionVersion.updateMany({
        where: { id: version.id, state: 'COMPILING' },
        data: { state: 'READY', number, readyAt: now },
      });
      if (!ready.count) return;
      await this.move(
        tx,
        { userId: version.sentById, ip: version.sentIp },
        submission,
        ['DRAFT', 'FEEDBACK_SENT'],
        {
          status: next,
          ...(submission.submittedAt ? {} : { submittedAt: now }),
        },
        'SUBMISSION_SENT',
        { number, files: version.files as Prisma.InputJsonArray },
      );
    });
  }

  // ───────────── Reviewing ─────────────

  /** The user's role as a reviewer of this submission (null when not one of its reviewers). */
  private roleAsReviewer(
    userId: string,
    access: ProjectAccess,
    submission: SubmissionRow,
  ): ProjectRole | null {
    if (!submission.reviewers.some((item) => item.reviewerId === userId)) return null;
    return isReviewerRole(access.role) ? access.role : null;
  }

  /**
   * Opened by a reviewer: the time of their last reading is kept, and a submission just
   * received (or revised) moves to IN_REVIEW.
   */
  async open(actor: SubmissionActor, projectId: string, submissionId: string) {
    const { access, submission } = await this.load(actor.userId, projectId, submissionId);
    if (!this.roleAsReviewer(actor.userId, access, submission)) {
      return this.detail(actor.userId, projectId, submissionId);
    }
    const db = this.prisma.client;
    await db.$transaction(async (tx) => {
      await tx.submissionReviewer.updateMany({
        where: { submissionId, reviewerId: actor.userId },
        data: { lastReviewedAt: new Date() },
      });
      if (submission.status === 'SUBMITTED' || submission.status === 'REVISED') {
        const moved = await tx.submission.updateMany({
          where: { id: submissionId, status: { in: ['SUBMITTED', 'REVISED'] } },
          data: { status: 'IN_REVIEW' },
        });
        // Opened by two reviewers at once: one entry.
        if (moved.count) {
          await this.audit(tx, actor, 'SUBMISSION_REVIEW_STARTED', submission, {
            status: 'IN_REVIEW',
            number: this.lastReady(submission)?.number ?? null,
          });
        }
      }
    });
    return this.detail(actor.userId, projectId, submissionId);
  }

  private lastReady(submission: SubmissionRow): VersionRow | undefined {
    return submission.versions.find((version) => version.state === 'READY');
  }

  /**
   * Sendings still COMPILING whose compilation ended without its result being applied (event
   * missed, crash), or that never got a compilation (crash right after the sending), are
   * finished now: otherwise the submission could never be sent again. True when one changed.
   */
  private async reconcile(submission: SubmissionRow, ownerId: string): Promise<boolean> {
    let changed = false;
    for (const version of submission.versions) {
      if (version.state !== 'COMPILING') continue;
      if (version.compilation) {
        const row = await this.compile.refreshFrozen(version.compilation, ownerId);
        if (row.status !== 'QUEUED' && row.status !== 'RUNNING') {
          // Applied once: `compiled` only changes a version still COMPILING.
          await this.compiled(row);
          changed = true;
        }
      } else if (Date.now() - version.createdAt.getTime() > ORPHAN_SENDING_MS) {
        await this.refuse(version.id, version.projectVersionId);
        changed = true;
      }
    }
    return changed;
  }

  /** Feedback sent (any reviewer): the student corrects and sends a new version. */
  async feedback(actor: SubmissionActor, projectId: string, submissionId: string) {
    const { access, submission } = await this.load(actor.userId, projectId, submissionId);
    if (!this.roleAsReviewer(actor.userId, access, submission))
      fail(HttpStatus.FORBIDDEN, 'forbidden');
    await this.prisma.client.$transaction((tx) =>
      this.move(
        tx,
        actor,
        submission,
        ['IN_REVIEW'],
        { status: 'FEEDBACK_SENT' },
        'SUBMISSION_FEEDBACK_SENT',
        { number: this.lastReady(submission)?.number ?? null },
      ),
    );
    return this.detail(actor.userId, projectId, submissionId);
  }

  /** A supervisor among the reviewers (only they validate, unlock and set deadlines). */
  private requireSupervisor(userId: string, access: ProjectAccess, submission: SubmissionRow) {
    if (this.roleAsReviewer(userId, access, submission) !== 'SUPERVISOR') {
      fail(HttpStatus.FORBIDDEN, 'forbidden');
    }
  }

  /**
   * Validates the last version (the one the supervisor read, `number`). The files it holds are
   * put back as they were sent when they changed since (the state before is saved first as the
   * version "Avant validation"), then locked; the trace of the validation keeps who, when, which
   * submission and the SHA-256 of the files, and outlives the project.
   */
  async validate(actor: SubmissionActor, projectId: string, submissionId: string, number: number) {
    const { access, submission } = await this.load(actor.userId, projectId, submissionId);
    this.requireSupervisor(actor.userId, access, submission);
    if (submission.status !== 'IN_REVIEW') fail(HttpStatus.CONFLICT, 'submission_state');
    const version = this.lastReady(submission);
    if (!version || version.number !== number) fail(HttpStatus.CONFLICT, 'version_changed');
    const project = access.project;
    const db = this.prisma.client;
    const projectVersion = await db.projectVersion.findUniqueOrThrow({
      where: { id: version!.projectVersionId },
    });
    const manifest = await this.history.readManifest(projectVersion);
    const owner = await db.user.findUniqueOrThrow({ where: { id: project.ownerId } });
    const beforeLabel = BEFORE_VALIDATION_LABEL[owner.locale];

    const { restored, locked, beforeVersionId } = await this.projects.runLocked(
      project.ownerId,
      async () => {
        // Checked again under the lock: trashed, or moved on meanwhile (feedback, validation).
        const fresh = await db.project.findUnique({ where: { id: projectId } });
        if (!fresh || fresh.deletedAt) return fail(HttpStatus.NOT_FOUND, 'not_found');
        const latest = await db.submission.findFirst({
          where: { id: submissionId, projectId },
          include: INCLUDE,
        });
        if (latest?.status !== 'IN_REVIEW') return fail(HttpStatus.CONFLICT, 'submission_state');
        if (this.lastReady(latest)?.number !== number) fail(HttpStatus.CONFLICT, 'version_changed');

        const current = await db.projectFile.findMany({ where: { projectId } });
        const byPath = new Map(current.map((file) => [file.path, file]));
        // Files validated by another submission are neither changed nor taken over.
        const lockedElsewhere = version!.filePaths.some((path) => {
          const lock = byPath.get(path)?.lockedBySubmissionId;
          return lock && lock !== submissionId;
        });
        if (lockedElsewhere) fail(HttpStatus.CONFLICT, 'file_locked');
        const changed = version!.filePaths.filter((path) => {
          const frozen = manifest.files.find((file) => file.path === path);
          const now = byPath.get(path);
          return frozen && (!now || blobOf(now) !== frozen.blob);
        });
        const remaining = current.map((file) => file.path);
        for (const path of changed) {
          if (!byPath.has(path) && pathConflicts(remaining, path)) {
            fail(HttpStatus.CONFLICT, 'validation_conflict');
          }
          remaining.push(path);
        }
        const added = changed.reduce((total, path) => {
          const frozen = manifest.files.find((file) => file.path === path)!;
          return total + frozen.sizeBytes - (byPath.get(path)?.sizeBytes ?? 0);
        }, 0);
        if (added > 0) await this.projects.checkStorageFor(project.ownerId, added);

        let before: string | null = null;
        if (changed.length) {
          // Nothing is lost: the state before the validation becomes a named version.
          const saved = await this.history.snapshotLocked(projectId, 'NAMED', {
            userId: actor.userId,
            label: beforeLabel,
          });
          before = saved?.id ?? null;
        }

        // The validated content goes to new objects first; the rows change in the transaction
        // of the validation, so a refused validation changes no file.
        const writes: { path: string; storageKey: string }[] = [];
        const validatedAt = new Date();
        try {
          for (const path of changed) {
            const frozen = manifest.files.find((file) => file.path === path)!;
            const storageKey = this.projects.newKey(projectId);
            if (frozen.blob) {
              await this.storage.copy(PROJECTS_BUCKET, blobKey(projectId, frozen.blob), storageKey);
            } else {
              await this.storage.put(PROJECTS_BUCKET, storageKey, new Uint8Array());
            }
            writes.push({ path, storageKey });
          }
          await db.$transaction(async (tx) => {
            await this.move(
              tx,
              actor,
              submission,
              ['IN_REVIEW'],
              {
                status: 'VALIDATED',
                validatedAt,
                validatedById: actor.userId,
                validatedNumber: number,
              },
              'SUBMISSION_VALIDATED',
              {
                number,
                files: version!.files as Prisma.InputJsonArray,
                restored: changed,
                beforeVersionId: before,
                beforeVersionLabel: before ? beforeLabel : null,
              },
            );
            for (const { path, storageKey } of writes) {
              const frozen = manifest.files.find((file) => file.path === path)!;
              const now = byPath.get(path);
              if (now) {
                await tx.projectFile.update({
                  where: { id: now.id },
                  data: { storageKey, sizeBytes: frozen.sizeBytes },
                });
              } else {
                await tx.projectFile.create({
                  data: {
                    projectId,
                    path,
                    kind: frozen.kind,
                    storageKey,
                    sizeBytes: frozen.sizeBytes,
                  },
                });
              }
            }
            const locked = await tx.projectFile.updateMany({
              where: { projectId, path: { in: version!.filePaths }, lockedBySubmissionId: null },
              data: { lockedBySubmissionId: submissionId },
            });
            if (locked.count !== version!.filePaths.length)
              fail(HttpStatus.CONFLICT, 'file_locked');
            await tx.validationRecord.create({
              data: {
                submissionId,
                validatedById: actor.userId,
                validatedAt,
                files: version!.files as Prisma.InputJsonArray,
              },
            });
          });
        } catch (error) {
          await this.storage
            .deleteKeys(
              PROJECTS_BUCKET,
              writes.map((write) => write.storageKey),
            )
            .catch(() => undefined);
          throw error;
        }
        const obsolete = changed.flatMap((path) => {
          const key = byPath.get(path)?.storageKey;
          return key ? [key] : [];
        });
        await this.storage.deleteKeys(PROJECTS_BUCKET, obsolete).catch(() => undefined);
        // Every text file now locked: its open editors drop what they have not stored.
        const lockedIds = version!.filePaths.flatMap((path) => {
          const now = byPath.get(path);
          return now?.kind === 'TEXT' ? [now.id] : [];
        });
        return { restored: changed, locked: lockedIds, beforeVersionId: before };
      },
    );

    for (const fileId of locked) {
      await this.events.publish({ type: 'file-locked', projectId, fileId });
    }
    // Open editors of the locked files become read-only at once.
    await this.events.publish({ type: 'project-access', projectId });
    if (restored.length) await this.events.changed(projectId);
    this.logger.log({ projectId, submissionId, beforeVersionId }, 'Submission validated');
    return this.detail(actor.userId, projectId, submissionId);
  }

  /**
   * Unlocks the validated files (a supervisor among the reviewers). The submission stays
   * validated and closed; its frozen versions, their PDFs and the trace are kept as they are.
   */
  async unlock(actor: SubmissionActor, projectId: string, submissionId: string) {
    const { access, submission } = await this.load(actor.userId, projectId, submissionId);
    this.requireSupervisor(actor.userId, access, submission);
    if (submission.status !== 'VALIDATED' || submission.unlockedAt) {
      fail(HttpStatus.CONFLICT, 'submission_state');
    }
    await this.prisma.client.$transaction(async (tx) => {
      const changed = await tx.submission.updateMany({
        where: { id: submissionId, status: 'VALIDATED', unlockedAt: null },
        data: { unlockedAt: new Date(), unlockedById: actor.userId },
      });
      if (!changed.count) fail(HttpStatus.CONFLICT, 'submission_state');
      await tx.projectFile.updateMany({
        where: { projectId, lockedBySubmissionId: submissionId },
        data: { lockedBySubmissionId: null },
      });
      await this.audit(tx, actor, 'SUBMISSION_UNLOCKED', submission, {
        number: submission.validatedNumber,
      });
    });
    await this.events.publish({ type: 'project-access', projectId });
    return this.detail(actor.userId, projectId, submissionId);
  }

  /** Deadline set by a supervisor among the reviewers, once sent and until validation. */
  async setDue(
    actor: SubmissionActor,
    projectId: string,
    submissionId: string,
    dueAt: string | null,
  ) {
    const { access, submission } = await this.load(actor.userId, projectId, submissionId);
    this.requireSupervisor(actor.userId, access, submission);
    if (submission.status === 'DRAFT' || submission.status === 'VALIDATED') {
      fail(HttpStatus.CONFLICT, 'submission_state');
    }
    await this.prisma.client.$transaction(async (tx) => {
      // Not validated meanwhile.
      const changed = await tx.submission.updateMany({
        where: { id: submissionId, status: { notIn: ['DRAFT', 'VALIDATED'] } },
        data: { dueAt: dueAt ? new Date(dueAt) : null },
      });
      if (!changed.count) fail(HttpStatus.CONFLICT, 'submission_state');
      await this.audit(tx, actor, 'SUBMISSION_DUE_CHANGED', submission, { dueAt });
    });
    return this.detail(actor.userId, projectId, submissionId);
  }

  // ───────────── Reading ─────────────

  private summary(submission: SummaryRow): SubmissionSummary {
    const ready = submission.versions.find((version) => version.state === 'READY');
    return {
      id: submission.id,
      projectId: submission.projectId,
      title: submission.title,
      status: submission.status,
      dueAt: submission.dueAt?.toISOString() ?? null,
      author: personOf(submission.author),
      reviewers: submission.reviewers.map((item) => personOf(item.reviewer)),
      lastNumber: ready?.number ?? null,
      sending: submission.versions.some((version) => version.state === 'COMPILING'),
      submittedAt: submission.submittedAt?.toISOString() ?? null,
      receivedAt: ready?.readyAt?.toISOString() ?? null,
      updatedAt: submission.updatedAt.toISOString(),
    };
  }

  async list(userId: string, projectId: string): Promise<SubmissionList> {
    const { project, rights } = await this.projects.access(userId, projectId);
    const db = this.prisma.client;
    const [rows, members] = await Promise.all([
      db.submission.findMany({
        where: { projectId },
        include: SUMMARY_INCLUDE,
        orderBy: { updatedAt: 'desc' },
      }),
      db.projectMember.findMany({
        where: { projectId, role: { in: [...REVIEWER_ROLES] } },
        include: { user: person },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    return {
      submissions: rows.map((row) => this.summary(row)),
      canCreate: rights.edit && !project.readOnlyReason,
      candidates: members.map((member) => ({
        ...personOf(member.user),
        role: member.role as (typeof REVIEWER_ROLES)[number],
      })),
    };
  }

  async detail(userId: string, projectId: string, submissionId: string): Promise<SubmissionDetail> {
    let { access, submission } = await this.load(userId, projectId, submissionId);
    const { project } = access;
    // A sending whose worker event was missed, or left behind by a crash, is finished now (it may
    // change the status).
    if (await this.reconcile(submission, project.ownerId)) {
      ({ access, submission } = await this.load(userId, projectId, submissionId));
    }
    const compilations = new Map<string, Compilation>();
    for (const version of submission.versions) {
      if (version.compilation) {
        compilations.set(
          version.id,
          await this.compile.frozenView(version.compilation, project.name),
        );
      }
    }

    const db = this.prisma.client;
    const roles = await this.rolesOf(
      project,
      submission.reviewers.map((item) => item.reviewerId),
    );
    const reviewerRole = this.roleAsReviewer(userId, access, submission);
    const supervisor = reviewerRole === 'SUPERVISOR';
    const writer = access.rights.edit && !project.readOnlyReason;
    const sending = submission.versions.some((version) => version.state === 'COMPILING');
    const status = submission.status;
    const last = this.lastReady(submission);

    const [audits, validatedBy, unlockedBy] = await Promise.all([
      db.auditLog.findMany({
        where: { targetType: 'Submission', targetId: submission.id },
        include: { actor: person },
        orderBy: { createdAt: 'asc' },
      }),
      submission.validatedById
        ? db.user.findUnique({ where: { id: submission.validatedById }, ...person })
        : null,
      submission.unlockedById
        ? db.user.findUnique({ where: { id: submission.unlockedById }, ...person })
        : null,
    ]);

    let changedSinceSent: string[] = [];
    if (supervisor && status === 'IN_REVIEW' && last) {
      changedSinceSent = await this.changedSince(projectId, last);
    }

    return {
      ...this.summary(submission),
      projectName: project.name,
      filePaths: submission.filePaths,
      message: submission.message,
      reviewerDetails: submission.reviewers.map((item) => ({
        ...personOf(item.reviewer),
        role: roles.get(item.reviewerId) ?? null,
        lastReviewedAt: item.lastReviewedAt?.toISOString() ?? null,
      })),
      versions: submission.versions.map((version) => ({
        id: version.id,
        number: version.number,
        state: version.state,
        filePaths: version.filePaths,
        message: version.message,
        files: version.files as SubmissionFileHash[],
        sentBy: personOf(version.sentBy),
        createdAt: version.createdAt.toISOString(),
        readyAt: version.readyAt?.toISOString() ?? null,
        compilation: compilations.get(version.id) ?? null,
      })),
      validatedAt: submission.validatedAt?.toISOString() ?? null,
      validatedBy: validatedBy ? personOf(validatedBy) : null,
      validatedNumber: submission.validatedNumber,
      unlockedAt: submission.unlockedAt?.toISOString() ?? null,
      unlockedBy: unlockedBy ? personOf(unlockedBy) : null,
      changedSinceSent,
      events: audits.flatMap((row) => this.event(row)),
      can: {
        edit: writer && status === 'DRAFT' && !sending,
        send: writer && (status === 'DRAFT' || status === 'FEEDBACK_SENT') && !sending,
        delete: writer && status === 'DRAFT' && !sending,
        feedback: reviewerRole !== null && status === 'IN_REVIEW',
        validate: supervisor && status === 'IN_REVIEW',
        unlock: supervisor && status === 'VALIDATED' && !submission.unlockedAt,
        setDue: supervisor && status !== 'DRAFT' && status !== 'VALIDATED',
      },
      isReviewer: reviewerRole !== null,
    };
  }

  /** Files of a version changed in the project since it was sent. */
  private async changedSince(projectId: string, version: VersionRow): Promise<string[]> {
    const db = this.prisma.client;
    const projectVersion = await db.projectVersion.findUniqueOrThrow({
      where: { id: version.projectVersionId },
    });
    const manifest = await this.history.readManifest(projectVersion);
    const current = await db.projectFile.findMany({
      where: { projectId, path: { in: version.filePaths } },
    });
    const byPath = new Map(current.map((file) => [file.path, file]));
    return version.filePaths.filter((path) => {
      const frozen = manifest.files.find((file) => file.path === path);
      const now = byPath.get(path);
      return !frozen || !now || blobOf(now) !== frozen.blob;
    });
  }

  private event(row: {
    action: string;
    createdAt: Date;
    actor: { id: string; displayName: string } | null;
    metadata: Prisma.JsonValue;
  }): SubmissionEvent[] {
    if (!(SUBMISSION_ACTIONS as readonly string[]).includes(row.action)) return [];
    const meta = (row.metadata ?? {}) as {
      number?: number | null;
      dueAt?: string | null;
      restored?: string[];
      beforeVersionId?: string | null;
      beforeVersionLabel?: string | null;
    };
    return [
      {
        action: row.action as SubmissionAction,
        at: row.createdAt.toISOString(),
        actor: row.actor ? personOf(row.actor) : null,
        number: meta.number ?? null,
        dueAt: meta.dueAt ?? null,
        restored: meta.restored ?? [],
        beforeVersionId: meta.beforeVersionId ?? null,
        beforeVersionLabel: meta.beforeVersionLabel ?? null,
      },
    ];
  }

  /**
   * Submissions the user has to review, in every project: they are one of the reviewers, still
   * a supervisor or reviewer of the project, and it was sent or revised. Nearest deadline first,
   * then the oldest received.
   */
  async toReview(userId: string): Promise<ToReviewList> {
    const db = this.prisma.client;
    const rows = await db.submission.findMany({
      where: {
        status: { in: [...TO_REVIEW_STATUSES] },
        reviewers: { some: { reviewerId: userId } },
        project: {
          deletedAt: null,
          members: { some: { userId, role: { in: [...REVIEWER_ROLES] } } },
        },
      },
      include: { ...SUMMARY_INCLUDE, project: { select: { name: true } } },
    });
    const items = rows.map((row) => ({ ...this.summary(row), projectName: row.project.name }));
    const time = (iso: string | null, empty: number) => (iso ? Date.parse(iso) : empty);
    items.sort(
      (a, b) =>
        time(a.dueAt, Infinity) - time(b.dueAt, Infinity) ||
        time(a.receivedAt, 0) - time(b.receivedAt, 0),
    );
    return { submissions: items };
  }

  // ───────────── Comparison ─────────────

  /**
   * Line-by-line differences of the files chosen in two versions of a submission (docs/spec.md,
   * "Comparaison"): what changed since the version read before.
   */
  async compare(
    userId: string,
    projectId: string,
    submissionId: string,
    fromNumber: number,
    toNumber: number,
  ): Promise<SubmissionComparison> {
    const { submission } = await this.load(userId, projectId, submissionId);
    await consumeLimit(this.redis.client, `rl:compare:${userId}`, COMPARES_PER_MINUTE, 60);
    const find = (number: number) =>
      submission.versions.find((version) => version.state === 'READY' && version.number === number);
    const from = find(fromNumber);
    const to = find(toNumber);
    if (!from || !to) return fail(HttpStatus.NOT_FOUND, 'not_found');
    const db = this.prisma.client;
    const [fromVersion, toVersion] = await Promise.all([
      db.projectVersion.findUniqueOrThrow({ where: { id: from.projectVersionId } }),
      db.projectVersion.findUniqueOrThrow({ where: { id: to.projectVersionId } }),
    ]);
    const [before, after] = await Promise.all([
      this.history.readManifest(fromVersion),
      this.history.readManifest(toVersion),
    ]);
    const paths = [...new Set([...from.filePaths, ...to.filePaths])].sort((a, b) =>
      a.localeCompare(b),
    );
    const text = async (blob: string | null) =>
      blob ? decoder.decode(await this.storage.get(PROJECTS_BUCKET, blobKey(projectId, blob))) : '';
    const files: FileComparison[] = [];
    // The text compared in one request is bounded (time and memory of the API, size of the
    // answer); the files beyond the budget show "too large".
    let budget = COMPARE_BUDGET_BYTES;
    for (const path of paths) {
      const a = before.files.find((file) => file.path === path);
      const b = after.files.find((file) => file.path === path);
      const kind = (b ?? a)!.kind;
      const change = !a ? 'added' : !b ? 'removed' : a.blob === b.blob ? 'same' : 'modified';
      const empty = { hunks: [], added: 0, removed: 0, tooLarge: false };
      const size = (a?.sizeBytes ?? 0) + (b?.sizeBytes ?? 0);
      if (kind !== 'TEXT' || change === 'same') {
        files.push({ path, kind, change, ...empty });
      } else if (size > budget) {
        files.push({ path, kind, change, ...empty, tooLarge: true });
      } else {
        budget -= size;
        const diff = diffTexts(
          await text(a?.blob ?? null),
          await text(b?.blob ?? null),
          DIFF_CONTEXT_LINES,
        );
        files.push({ path, kind, change, ...diff });
        // Lets other requests run between files.
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    return { from: fromNumber, to: toNumber, files };
  }
}
