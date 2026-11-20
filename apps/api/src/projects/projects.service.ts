import type { Engine, Prisma, Project, ProjectRole } from '@integris/db';
import {
  type ApiErrorCode,
  COMPILE_CACHE_BUCKET,
  COMPILE_OUTPUT_BUCKET,
  type ImportResult,
  MAX_PROJECT_FILE_BYTES,
  normalizeFilePath,
  projectFolders,
  PROJECTS_BUCKET,
  projectRights,
  type ProjectDetail,
  type ProjectList,
  type ProjectRights,
  projectStoragePrefix,
  type ProjectSummary,
  TRASH_RETENTION_DAYS,
} from '@integris/shared';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../common/api-error.js';
import { ApiConfig } from '../config/api-config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { StorageService } from '../storage/storage.service.js';
import { OwnerLockService, Slots } from './owner-lock.service.js';
import { ProjectEventsService } from './project-events.service.js';
import { QuotaService } from './quota.service.js';
import { UsageAlertsService } from './usage-alerts.service.js';
import { TemplatesService } from './templates.service.js';
import { type ExtractedFile, guessMainFile, readProjectZip, ZipError } from './zip-import.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// Uploads of one user read at the same time (each one 10 MB at most).
const UPLOADS_IN_FLIGHT = 3;
// Objects written to MinIO in parallel when a project is created.
const WRITE_BATCH = 8;

/** A file of a new project: its bytes, or the object of another project to copy. */
type NewFile = Pick<ExtractedFile, 'path' | 'kind'> &
  (
    | { bytes: Uint8Array; copyFrom?: undefined }
    | { bytes?: undefined; sizeBytes: number; copyFrom?: string }
  );

const sizeOf = (file: NewFile) => (file.bytes ? file.bytes.length : file.sizeBytes);
const totalSize = (files: NewFile[]) => files.reduce((total, file) => total + sizeOf(file), 0);

/** Settings of a new project, and its empty folders. */
type CreateOptions = Partial<Pick<Project, 'mainFilePath' | 'engine' | 'templateId'>> & {
  folders?: string[];
};

/** A project the user can reach, with their role on it. */
export interface ProjectAccess {
  project: Project;
  role: ProjectRole;
  rights: ProjectRights;
}

type Right = Exclude<keyof ProjectRights, 'read'>;

export const fail = (status: HttpStatus, code: ApiErrorCode): never => {
  throw new ApiError(status, code);
};

/** Starting document of an empty project, in the language of the interface. */
export function blankMainTex(locale: 'fr' | 'en', title: string): string {
  const babel = locale === 'fr' ? 'french' : 'english';
  // Braces and backslashes of the name must not break the document.
  const safeTitle = title.replace(/[\\{}$&#^_%~]/g, ' ').trim();
  return [
    '\\documentclass[a4paper,12pt]{article}',
    '\\usepackage[T1]{fontenc}',
    `\\usepackage[${babel}]{babel}`,
    '',
    `\\title{${safeTitle}}`,
    '\\author{}',
    '\\date{\\today}',
    '',
    '\\begin{document}',
    '\\maketitle',
    '',
    '',
    '',
    '\\end{document}',
    '',
  ].join('\n');
}

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly quota: QuotaService,
    private readonly locks: OwnerLockService,
    private readonly templates: TemplatesService,
    private readonly config: ApiConfig,
    private readonly redis: RedisService,
    private readonly events: ProjectEventsService,
    private readonly alerts: UsageAlertsService,
  ) {
    this.importSlots = new Slots(config.env.ZIP_MAX_CONCURRENT_IMPORTS);
  }

  /** ZIP imports running at the same time in this process. */
  private readonly importSlots: Slots;

  /** Runs an import (body reading included) in one of the import slots of this process. */
  withImportSlot<T>(task: () => Promise<T>): Promise<T> {
    return this.importSlots.run(task);
  }

  /**
   * At most UPLOADS_IN_FLIGHT uploads at the same time per user (all API processes), taken
   * before the body is read: one account cannot fill the memory with parallel uploads.
   */
  async withUploadSlot<T>(userId: string, task: () => Promise<T>): Promise<T> {
    const key = `inflight:upload:${userId}`;
    const replies = await this.redis.client.multi().incr(key).expire(key, 600).exec();
    try {
      if (Number(replies?.[0]?.[1] ?? 0) > UPLOADS_IN_FLIGHT) {
        throw new ApiError(HttpStatus.TOO_MANY_REQUESTS, 'busy');
      }
      return await task();
    } finally {
      await this.redis.client.decr(key);
    }
  }

  // ───────────── Access ─────────────

  /**
   * The project and the user's role, checked on every request. A project the user cannot reach
   * answers "not found", so its existence is never revealed. Only the owner sees it in the trash.
   */
  async access(userId: string, projectId: string, inTrash = false): Promise<ProjectAccess> {
    const project = await this.prisma.client.project.findUnique({
      where: { id: projectId },
      include: { members: { where: { userId }, select: { role: true } } },
    });
    if (!project) return fail(HttpStatus.NOT_FOUND, 'not_found');
    const role: ProjectRole | undefined =
      project.ownerId === userId ? 'OWNER' : project.members[0]?.role;
    if (!role) return fail(HttpStatus.NOT_FOUND, 'not_found');
    if (project.deletedAt && role !== 'OWNER') return fail(HttpStatus.NOT_FOUND, 'not_found');
    if (Boolean(project.deletedAt) !== inTrash) {
      return fail(
        inTrash ? HttpStatus.CONFLICT : HttpStatus.NOT_FOUND,
        inTrash ? 'not_in_trash' : 'not_found',
      );
    }
    return { project, role, rights: projectRights(role) };
  }

  /** Access with a right: editing also requires a project that is not read-only. */
  async require(userId: string, projectId: string, right: Right): Promise<ProjectAccess> {
    const access = await this.access(userId, projectId);
    if (!access.rights[right]) fail(HttpStatus.FORBIDDEN, 'forbidden');
    if (right === 'edit' && access.project.readOnlyReason) fail(HttpStatus.FORBIDDEN, 'read_only');
    return access;
  }

  // ───────────── Reading ─────────────

  async list(userId: string, view: 'active' | 'trash'): Promise<ProjectList> {
    const db = this.prisma.client;
    const where: Prisma.ProjectWhereInput =
      view === 'trash'
        ? { ownerId: userId, deletedAt: { not: null } }
        : {
            deletedAt: null,
            OR: [{ ownerId: userId }, { members: { some: { userId } } }],
          };
    const projects = await db.project.findMany({
      where,
      include: {
        owner: { select: { displayName: true } },
        members: { where: { userId }, select: { role: true } },
      },
      orderBy: view === 'trash' ? { deletedAt: 'desc' } : { lastActivityAt: 'desc' },
    });
    const sizes = await this.sizes(projects.map((project) => project.id));
    return {
      projects: projects.map((project) =>
        this.summary(project, project.ownerId === userId ? 'OWNER' : project.members[0]!.role, {
          ownerName: project.owner.displayName,
          sizeBytes: sizes.get(project.id) ?? 0,
        }),
      ),
      usage: await this.quota.usage(userId),
    };
  }

  async detail(userId: string, projectId: string): Promise<ProjectDetail> {
    const { project, role, rights } = await this.access(userId, projectId);
    const [owner, files, folders] = await Promise.all([
      this.prisma.client.user.findUniqueOrThrow({
        where: { id: project.ownerId },
        select: { displayName: true },
      }),
      this.prisma.client.projectFile.findMany({ where: { projectId }, orderBy: { path: 'asc' } }),
      this.prisma.client.projectFolder.findMany({ where: { projectId } }),
    ]);
    const sizeBytes = files.reduce((total, file) => total + file.sizeBytes, 0);
    return {
      ...this.summary(project, role, { ownerName: owner.displayName, sizeBytes }),
      mainFilePath: project.mainFilePath,
      engine: project.engine,
      rights,
      files: files.map((file) => ({
        id: file.id,
        path: file.path,
        kind: file.kind,
        sizeBytes: file.sizeBytes,
        locked: file.lockedBySubmissionId !== null,
        lockedBy: file.lockedBySubmissionId,
        updatedAt: file.updatedAt.toISOString(),
      })),
      folders: projectFolders(
        files.map((file) => file.path),
        folders.map((folder) => folder.path),
      ),
    };
  }

  private async sizes(projectIds: string[]): Promise<Map<string, number>> {
    if (!projectIds.length) return new Map();
    const rows = await this.prisma.client.projectFile.groupBy({
      by: ['projectId'],
      where: { projectId: { in: projectIds } },
      _sum: { sizeBytes: true },
    });
    return new Map(rows.map((row) => [row.projectId, row._sum.sizeBytes ?? 0]));
  }

  summary(
    project: Project,
    role: ProjectRole,
    extra: { ownerName: string; sizeBytes: number },
  ): ProjectSummary {
    return {
      id: project.id,
      name: project.name,
      role,
      ownerName: extra.ownerName,
      lastActivityAt: project.lastActivityAt.toISOString(),
      createdAt: project.createdAt.toISOString(),
      readOnly: project.readOnlyReason !== null,
      sizeBytes: extra.sizeBytes,
      deletedAt: project.deletedAt?.toISOString() ?? null,
      purgeAt: project.deletedAt
        ? new Date(project.deletedAt.getTime() + TRASH_RETENTION_DAYS * DAY_MS).toISOString()
        : null,
    };
  }

  // ───────────── Creation ─────────────

  createBlank(
    owner: { id: string; displayName: string },
    name: string,
    locale: 'fr' | 'en',
  ): Promise<ProjectSummary> {
    const main = new TextEncoder().encode(blankMainTex(locale, name));
    return this.createWithFiles(owner, name, [{ path: 'main.tex', bytes: main, kind: 'TEXT' }]);
  }

  async createFromTemplate(
    owner: { id: string; displayName: string },
    name: string,
    templateId: string,
  ): Promise<ProjectSummary> {
    const template = await this.templates.visible(owner.id, templateId);
    const archive = await this.storage.get(this.templates.bucket, template.storageKey);
    const { files, folders } = await this.extract(archive, Number.MAX_SAFE_INTEGER);
    return this.createWithFiles(owner, name, files, { templateId: template.id, folders });
  }

  /**
   * Imports a ZIP archive (Overleaf or Prism export) as a new project. A few imports run at the
   * same time per API process; the controller applies the rate limit per user.
   */
  async importZip(
    owner: { id: string; displayName: string },
    name: string,
    archive: Uint8Array,
  ): Promise<ImportResult> {
    const { env } = this.config;
    if (archive.length > env.ZIP_MAX_ARCHIVE_BYTES) {
      fail(HttpStatus.PAYLOAD_TOO_LARGE, 'archive_too_large');
    }
    return this.locked(owner.id, async () => {
      await this.checkProjectLimit(owner.id);
      const quotas = await this.quota.quotas(owner.id);
      const left = quotas.storageBytes - (await this.quota.storageUsed(owner.id));
      const { files, folders, skipped, skippedCount } = await this.extract(
        archive,
        Number(left > 0n ? left : 0n),
      );
      const project = await this.insert(owner, name, files, { folders });
      return { project, imported: files.length, skipped, skippedCount };
    });
  }

  /** Imports per user and per hour (ZIP_IMPORTS_PER_HOUR), counted before reading the archive. */
  async limitImports(userId: string): Promise<void> {
    const key = `rl:import:${userId}`;
    // One step: the counter can never be left without its expiry.
    const replies = await this.redis.client.multi().incr(key).expire(key, 3600, 'NX').exec();
    const count = Number(replies?.[0]?.[1] ?? 0);
    if (count > this.config.env.ZIP_IMPORTS_PER_HOUR) {
      const ttl = await this.redis.client.ttl(key);
      throw new ApiError(HttpStatus.TOO_MANY_REQUESTS, 'rate_limited', Math.max(ttl, 1));
    }
  }

  /**
   * Copies a project for its owner. Quotas are checked from the sizes in the database first, and
   * the objects are copied inside MinIO: nothing is loaded into the API memory.
   */
  async duplicate(
    user: { id: string; displayName: string },
    projectId: string,
    name: string,
  ): Promise<ProjectSummary> {
    const { project } = await this.require(user.id, projectId, 'manage');
    // Listed under the owner lock: an upload cannot replace a source object meanwhile.
    return this.createWithFiles(
      user,
      name,
      async () =>
        (await this.prisma.client.projectFile.findMany({ where: { projectId } })).map((source) => ({
          path: source.path,
          kind: source.kind,
          sizeBytes: source.sizeBytes,
          copyFrom: source.storageKey ?? undefined,
        })),
      {
        mainFilePath: project.mainFilePath,
        engine: project.engine,
        templateId: project.templateId,
        folders: (await this.prisma.client.projectFolder.findMany({ where: { projectId } })).map(
          (folder) => folder.path,
        ),
      },
    );
  }

  private async extract(archive: Uint8Array, storageLeftBytes: number) {
    const { env } = this.config;
    try {
      return await readProjectZip(archive, {
        maxFiles: env.ZIP_MAX_FILES,
        maxTotalBytes: env.ZIP_MAX_TOTAL_BYTES,
        maxFileBytes: MAX_PROJECT_FILE_BYTES,
        maxRatio: env.ZIP_MAX_RATIO,
        ratioMinBytes: env.ZIP_RATIO_MIN_BYTES,
        storageLeftBytes,
      });
    } catch (error) {
      if (!(error instanceof ZipError)) throw error;
      const status =
        error.code === 'storage_limit'
          ? HttpStatus.PAYMENT_REQUIRED
          : HttpStatus.UNPROCESSABLE_ENTITY;
      return fail(status, error.code);
    }
  }

  private async checkProjectLimit(ownerId: string): Promise<void> {
    const { maxProjects } = await this.quota.quotas(ownerId);
    if (maxProjects !== null && (await this.quota.countProjects(ownerId)) >= maxProjects) {
      fail(HttpStatus.PAYMENT_REQUIRED, 'project_limit');
    }
  }

  private async checkStorage(ownerId: string, addedBytes: number): Promise<void> {
    // Shrinking is always allowed, even above the limit (docs/spec.md, "Stockage au-delà").
    if (addedBytes <= 0) return;
    const quotas = await this.quota.quotas(ownerId);
    const used = await this.quota.storageUsed(ownerId);
    if (used + BigInt(addedBytes) > quotas.storageBytes) {
      fail(HttpStatus.PAYMENT_REQUIRED, 'storage_limit');
    }
  }

  private createWithFiles(
    owner: { id: string; displayName: string },
    name: string,
    source: NewFile[] | (() => Promise<NewFile[]>),
    options: CreateOptions = {},
  ): Promise<ProjectSummary> {
    return this.locked(owner.id, async () => {
      const files = typeof source === 'function' ? await source() : source;
      await this.checkProjectLimit(owner.id);
      await this.checkStorage(owner.id, totalSize(files));
      return this.insert(owner, name, files, options);
    });
  }

  /** Writes the project, its objects and its files; removes everything if a step fails. */
  private async insert(
    owner: { id: string; displayName: string },
    name: string,
    files: NewFile[],
    options: CreateOptions,
  ): Promise<ProjectSummary> {
    const db = this.prisma.client;
    const project = await db.project.create({
      data: {
        ownerId: owner.id,
        name,
        mainFilePath: options.mainFilePath ?? guessMainFile(files),
        engine: options.engine ?? 'PDFLATEX',
        templateId: options.templateId ?? null,
      },
    });
    try {
      const rows: Prisma.ProjectFileCreateManyInput[] = [];
      // A few objects at a time: fast enough for 2000 files, gentle with MinIO.
      for (let start = 0; start < files.length; start += WRITE_BATCH) {
        await Promise.all(
          files.slice(start, start + WRITE_BATCH).map(async (file) => {
            const storageKey = this.newKey(project.id);
            if (file.copyFrom) {
              await this.storage.copy(PROJECTS_BUCKET, file.copyFrom, storageKey);
            } else {
              await this.storage.put(PROJECTS_BUCKET, storageKey, file.bytes ?? new Uint8Array());
            }
            rows.push({
              projectId: project.id,
              path: file.path,
              kind: file.kind,
              storageKey,
              sizeBytes: sizeOf(file),
            });
          }),
        );
      }
      await db.projectFile.createMany({ data: rows });
      if (options.folders?.length) {
        await db.projectFolder.createMany({
          data: options.folders.map((path) => ({ projectId: project.id, path })),
        });
      }
    } catch (error) {
      await this.erase(project.id).catch((cleanup: unknown) =>
        this.logger.error({ err: cleanup, projectId: project.id }, 'Cleanup of a failed creation'),
      );
      throw error;
    }
    return this.summary(project, 'OWNER', {
      ownerName: owner.displayName,
      sizeBytes: totalSize(files),
    });
  }

  newKey(projectId: string): string {
    return `${projectStoragePrefix(projectId)}${randomUUID()}`;
  }

  // ───────────── Settings, trash ─────────────

  async update(
    userId: string,
    projectId: string,
    changes: { name?: string; mainFilePath?: string; engine?: Engine },
  ): Promise<ProjectDetail> {
    const access = await this.require(
      userId,
      projectId,
      changes.name !== undefined ? 'manage' : 'edit',
    );
    if (
      (changes.mainFilePath !== undefined || changes.engine !== undefined) &&
      access.project.readOnlyReason
    ) {
      fail(HttpStatus.FORBIDDEN, 'read_only');
    }
    if (changes.mainFilePath !== undefined) {
      const path = normalizeFilePath(changes.mainFilePath);
      const file = path
        ? await this.prisma.client.projectFile.findUnique({
            where: { projectId_path: { projectId, path } },
          })
        : null;
      if (!file || !path?.toLowerCase().endsWith('.tex'))
        fail(HttpStatus.BAD_REQUEST, 'invalid_path');
    }
    await this.prisma.client.project.update({
      where: { id: projectId },
      data: {
        name: changes.name,
        mainFilePath: changes.mainFilePath ? normalizeFilePath(changes.mainFilePath)! : undefined,
        engine: changes.engine,
        lastActivityAt: new Date(),
      },
    });
    return this.detail(userId, projectId);
  }

  async moveToTrash(userId: string, projectId: string): Promise<void> {
    await this.require(userId, projectId, 'manage');
    await this.prisma.client.project.update({
      where: { id: projectId },
      data: { deletedAt: new Date() },
    });
    // Open editors are disconnected.
    await this.events.publish({ type: 'project-access', projectId });
  }

  /** Restores a project from the trash; the project limit of the plan applies again. */
  async restore(userId: string, projectId: string): Promise<void> {
    await this.access(userId, projectId, true);
    await this.locked(userId, async () => {
      await this.checkProjectLimit(userId);
      await this.prisma.client.project.update({
        where: { id: projectId },
        data: { deletedAt: null, lastActivityAt: new Date() },
      });
    });
  }

  /** Erases a project of the trash at once, at the request of its owner. */
  async eraseFromTrash(userId: string, projectId: string): Promise<void> {
    await this.access(userId, projectId, true);
    if (!(await this.erase(projectId))) fail(HttpStatus.CONFLICT, 'erase_blocked');
  }

  /**
   * Erases a project for good, except the traces of its validations: its objects first (a failure leaves the rows, and the next purge
   * tries again), then its rows. Exam papers with print requests keep their append-only journal:
   * they are not erased here.
   */
  async erase(projectId: string): Promise<boolean> {
    const db = this.prisma.client;
    if (await db.printRequest.count({ where: { projectId } })) {
      this.logger.warn({ projectId }, 'Project with print requests not erased');
      return false;
    }
    // Validated submissions are erased with the project, but the trace of each validation
    // (ValidationRecord, metadata only) is kept. Never erase one whose trace is missing.
    const validated = await db.submission.findMany({
      where: { projectId, status: 'VALIDATED' },
      select: { id: true },
    });
    if (validated.length) {
      const traced = await db.validationRecord.count({
        where: { submissionId: { in: validated.map((submission) => submission.id) } },
      });
      if (traced < validated.length) {
        this.logger.error({ projectId }, 'Validated submission without trace: project not erased');
        return false;
      }
    }
    await this.storage.deletePrefix(PROJECTS_BUCKET, projectStoragePrefix(projectId));
    // Compilation results and cache share the project prefix.
    await this.storage.deletePrefix(COMPILE_OUTPUT_BUCKET, projectStoragePrefix(projectId));
    await this.storage.deletePrefix(COMPILE_CACHE_BUCKET, projectStoragePrefix(projectId));
    await db.$transaction([
      db.commentReply.deleteMany({ where: { comment: { projectId } } }),
      db.comment.deleteMany({ where: { projectId } }),
      db.compilation.deleteMany({ where: { projectId } }),
      db.submissionVersion.deleteMany({ where: { submission: { projectId } } }),
      db.submissionReviewer.deleteMany({ where: { submission: { projectId } } }),
      db.submission.deleteMany({ where: { projectId } }),
      db.projectVersion.deleteMany({ where: { projectId } }),
      db.shareLinkOpening.deleteMany({ where: { link: { projectId } } }),
      db.shareLink.deleteMany({ where: { projectId } }),
      db.projectInvitation.deleteMany({ where: { projectId } }),
      db.projectMember.deleteMany({ where: { projectId } }),
      db.projectFile.deleteMany({ where: { projectId } }),
      db.projectFolder.deleteMany({ where: { projectId } }),
      db.project.delete({ where: { id: projectId } }),
    ]);
    return true;
  }

  /** Erases the projects deleted more than 30 days ago. */
  async purgeTrash(now = new Date()): Promise<number> {
    const before = new Date(now.getTime() - TRASH_RETENTION_DAYS * DAY_MS);
    const expired = await this.prisma.client.project.findMany({
      // Exam papers keep their print journal: never picked, so they cannot block the others.
      where: { deletedAt: { lt: before }, printRequests: { none: {} } },
      select: { id: true },
      orderBy: { deletedAt: 'asc' },
      take: 100,
    });
    let erased = 0;
    for (const { id } of expired) {
      try {
        if (await this.erase(id)) erased++;
      } catch (error) {
        this.logger.error({ err: error, projectId: id }, 'Trash purge failed');
      }
    }
    return erased;
  }

  // ───────────── Helpers for files ─────────────

  checkStorageFor(ownerId: string, addedBytes: number): Promise<void> {
    return this.checkStorage(ownerId, addedBytes);
  }

  runLocked<T>(ownerId: string, task: () => Promise<T>): Promise<T> {
    return this.locked(ownerId, task);
  }

  /**
   * Runs a write of a project under its owner's lock, after checking again that the project is
   * not read-only: it may have become so (plan limits) while the lock was awaited.
   */
  runWritable<T>(project: { id: string; ownerId: string }, task: () => Promise<T>): Promise<T> {
    return this.locked(project.ownerId, async () => {
      const fresh = await this.prisma.client.project.findUnique({ where: { id: project.id } });
      if (fresh?.readOnlyReason) fail(HttpStatus.FORBIDDEN, 'read_only');
      return task();
    });
  }

  /**
   * Runs a task that may add projects or bytes to an owner under their lock, then checks their
   * usage for the 80 % and 100 % alerts.
   */
  private async locked<T>(ownerId: string, task: () => Promise<T>): Promise<T> {
    try {
      return await this.locks.run(ownerId, task);
    } finally {
      this.alerts.check(ownerId);
    }
  }

  touch(projectId: string): Promise<unknown> {
    return this.prisma.client.project.update({
      where: { id: projectId },
      data: { lastActivityAt: new Date() },
    });
  }
}
