import type { ProjectFile, ProjectVersion, VersionKind } from '@integris/db';
import {
  pathConflicts,
  PROJECTS_BUCKET,
  projectStoragePrefix,
  type RestoreResult,
  type VersionDetail,
  type VersionList,
  type VersionSummary,
} from '@integris/shared';
import { HttpStatus, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../common/api-error.js';
import { ApiConfig } from '../config/api-config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectEventsService } from '../projects/project-events.service.js';
import { fail, ProjectsService } from '../projects/projects.service.js';
import { QuotaService } from '../projects/quota.service.js';
import { RedisService } from '../redis/redis.service.js';
import { StorageService } from '../storage/storage.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// Versions listed at most (the most recent).
const LIST_LIMIT = 200;

/**
 * A file in a version: its content is the history object `blob` (null for an empty file).
 * `fileId` (versions taken since step 4 bis) follows the file through moves; older versions
 * are matched by path.
 */
export interface ManifestFile {
  fileId?: string;
  path: string;
  kind: ProjectFile['kind'];
  sizeBytes: number;
  blob: string | null;
}

/** What a version holds, stored as JSON under the project prefix. */
export interface Manifest {
  mainFilePath: string;
  files: ManifestFile[];
  /** Kept folders (empty ones); absent from versions taken before step 4 bis. */
  folders?: string[];
}

/** The current file a file of a version stands for: same id, or same path for old versions. */
export function matcher<T extends Pick<ProjectFile, 'id' | 'path'>>(current: T[]) {
  const byId = new Map(current.map((file) => [file.id, file]));
  const byPath = new Map(current.map((file) => [file.path, file]));
  return (file: Pick<ManifestFile, 'fileId' | 'path'>): T | undefined =>
    file.fileId ? byId.get(file.fileId) : byPath.get(file.path);
}

/**
 * History objects are named after the storage object they copy. Every write of a file goes to a
 * new object, so an unchanged file keeps its name and is copied once for all versions.
 */
export const blobOf = (file: Pick<ProjectFile, 'storageKey'>) =>
  file.storageKey ? file.storageKey.slice(file.storageKey.lastIndexOf('/') + 1) : null;
export const blobKey = (projectId: string, blob: string) =>
  `${projectStoragePrefix(projectId)}history/${blob}`;

const sameManifest = (a: Manifest, b: Manifest) => {
  if (a.mainFilePath !== b.mainFilePath || a.files.length !== b.files.length) return false;
  if ((a.folders ?? []).join('\n') !== (b.folders ?? []).join('\n')) return false;
  const blobs = new Map(b.files.map((file) => [file.path, file.blob]));
  return a.files.every((file) => blobs.has(file.path) && blobs.get(file.path) === file.blob);
};

// Temporary path of a file during a restoration that swaps paths: "#" is refused in project
// paths, so it never meets a real file (and PostgreSQL text accepts it, unlike NUL).
const parked = (id: string) => `#restore/${id}`;

export interface VersionOptions {
  label?: string | null;
  userId?: string | null;
  restoreOfId?: string | null;
  restorePath?: string | null;
  /** Automatic versions are skipped when nothing changed since the previous version. */
  skipUnchanged?: boolean;
}

/**
 * Version history of projects (docs/spec.md, "Projets" → "Historique"): automatic versions
 * 10 minutes after a change, named versions, restoration of the project or of one file within
 * the history limit of the owner's plan. Older versions are hidden, never deleted.
 */
@Injectable()
export class HistoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly projects: ProjectsService,
    private readonly quota: QuotaService,
    private readonly events: ProjectEventsService,
    private readonly config: ApiConfig,
    private readonly redis: RedisService,
  ) {}

  /**
   * Named versions and restorations per user and per hour (HISTORY_ACTIONS_PER_HOUR): each one
   * copies files to the history, which is kept and not counted in the quota.
   */
  private async limit(userId: string): Promise<void> {
    const key = `rl:history:${userId}`;
    const replies = await this.redis.client.multi().incr(key).expire(key, 3600, 'NX').exec();
    if (Number(replies?.[0]?.[1] ?? 0) > this.config.env.HISTORY_ACTIONS_PER_HOUR) {
      const ttl = await this.redis.client.ttl(key);
      throw new ApiError(HttpStatus.TOO_MANY_REQUESTS, 'rate_limited', Math.max(ttl, 1));
    }
  }

  // ───────────── Taking versions ─────────────

  /** Takes a version of the project as stored now; null when skipped (no change, trashed). */
  async createVersion(
    projectId: string,
    kind: VersionKind,
    options: VersionOptions = {},
  ): Promise<ProjectVersion | null> {
    const project = await this.prisma.client.project.findUnique({ where: { id: projectId } });
    if (!project || project.deletedAt) return null;
    // Serialized with the writes of the owner: no object is replaced while it is copied.
    return this.projects.runLocked(project.ownerId, () => this.snapshot(projectId, kind, options));
  }

  /** Takes a version for a caller that already holds the owner lock (validation). */
  snapshotLocked(
    projectId: string,
    kind: VersionKind,
    options: VersionOptions = {},
  ): Promise<ProjectVersion | null> {
    return this.snapshot(projectId, kind, options);
  }

  /** Copies what is missing to the history objects, then writes the manifest. Under the lock. */
  private async snapshot(
    projectId: string,
    kind: VersionKind,
    options: VersionOptions,
  ): Promise<ProjectVersion | null> {
    const db = this.prisma.client;
    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project) return null;
    const files = await db.projectFile.findMany({ where: { projectId } });
    const folders = await db.projectFolder.findMany({ where: { projectId } });
    const manifest: Manifest = {
      mainFilePath: project.mainFilePath,
      folders: folders.map((folder) => folder.path).sort(),
      files: files
        .map((file) => ({
          fileId: file.id,
          path: file.path,
          kind: file.kind,
          sizeBytes: file.sizeBytes,
          blob: blobOf(file),
        }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    };
    const previous = await db.projectVersion.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    const before = previous ? await this.readManifest(previous).catch(() => null) : null;
    if (options.skipUnchanged && before && sameManifest(before, manifest)) return null;

    const known = new Set(before?.files.map((file) => file.blob) ?? []);
    for (const file of files) {
      const blob = blobOf(file);
      if (!blob || known.has(blob)) continue;
      const target = blobKey(projectId, blob);
      if (!(await this.storage.exists(PROJECTS_BUCKET, target))) {
        await this.storage.copy(PROJECTS_BUCKET, file.storageKey!, target);
      }
      known.add(blob);
    }
    const storageKey = `${projectStoragePrefix(projectId)}history/manifest-${randomUUID()}.json`;
    await this.storage.put(
      PROJECTS_BUCKET,
      storageKey,
      new TextEncoder().encode(JSON.stringify(manifest)),
    );
    return db.projectVersion.create({
      data: {
        projectId,
        kind,
        label: options.label ?? null,
        storageKey,
        fileCount: manifest.files.length,
        restoreOfId: options.restoreOfId ?? null,
        restorePath: options.restorePath ?? null,
        createdById: options.userId ?? null,
      },
    });
  }

  async readManifest(version: Pick<ProjectVersion, 'storageKey'>): Promise<Manifest> {
    const bytes = await this.storage.get(PROJECTS_BUCKET, version.storageKey);
    return JSON.parse(new TextDecoder().decode(bytes)) as Manifest;
  }

  /** Named version, asked by the owner or an editor. */
  async createNamed(userId: string, projectId: string, label: string): Promise<VersionSummary> {
    await this.projects.require(userId, projectId, 'edit');
    await this.limit(userId);
    const version = await this.createVersion(projectId, 'NAMED', { label, userId });
    if (!version) return fail(HttpStatus.NOT_FOUND, 'not_found');
    return (await this.summaries([version]))[0]!;
  }

  // ───────────── Reading ─────────────

  /** First instant shown by the history limit of the owner's plan; null when unlimited. */
  private async since(ownerId: string): Promise<Date | null> {
    const { historyDays } = await this.quota.quotas(ownerId);
    return historyDays === null ? null : new Date(Date.now() - historyDays * DAY_MS);
  }

  /** Versions shown: within the limit, and the frozen versions of submissions. */
  private visible(projectId: string, since: Date | null) {
    return since
      ? { projectId, OR: [{ createdAt: { gte: since } }, { kind: 'SUBMISSION' as const }] }
      : { projectId };
  }

  async list(userId: string, projectId: string): Promise<VersionList> {
    const { project, rights } = await this.projects.access(userId, projectId);
    const since = await this.since(project.ownerId);
    const db = this.prisma.client;
    const [versions, hiddenCount, { historyDays }] = await Promise.all([
      db.projectVersion.findMany({
        where: this.visible(projectId, since),
        orderBy: { createdAt: 'desc' },
        take: LIST_LIMIT,
      }),
      since
        ? db.projectVersion.count({
            where: { projectId, createdAt: { lt: since }, kind: { not: 'SUBMISSION' } },
          })
        : Promise.resolve(0),
      this.quota.quotas(project.ownerId),
    ]);
    return {
      versions: await this.summaries(versions),
      historyDays,
      hiddenCount,
      canRestore: rights.edit && !project.readOnlyReason,
    };
  }

  private async summaries(versions: ProjectVersion[]): Promise<VersionSummary[]> {
    const db = this.prisma.client;
    const authorIds = [...new Set(versions.flatMap((v) => (v.createdById ? [v.createdById] : [])))];
    const restoredIds = [
      ...new Set(versions.flatMap((v) => (v.restoreOfId ? [v.restoreOfId] : []))),
    ];
    const [authors, restored] = await Promise.all([
      authorIds.length
        ? db.user.findMany({
            where: { id: { in: authorIds } },
            select: { id: true, displayName: true },
          })
        : Promise.resolve([]),
      restoredIds.length
        ? db.projectVersion.findMany({
            where: { id: { in: restoredIds } },
            select: { id: true, createdAt: true },
          })
        : Promise.resolve([]),
    ]);
    const names = new Map(authors.map((user) => [user.id, user.displayName]));
    const dates = new Map(restored.map((version) => [version.id, version.createdAt]));
    return versions.map((version) => ({
      id: version.id,
      kind: version.kind,
      label: version.label,
      createdAt: version.createdAt.toISOString(),
      authorName: version.createdById ? (names.get(version.createdById) ?? null) : null,
      fileCount: version.fileCount,
      restoreOf: version.restoreOfId
        ? {
            createdAt: dates.get(version.restoreOfId)?.toISOString() ?? null,
            path: version.restorePath,
          }
        : null,
    }));
  }

  /** A version the user may see: hidden versions answer "not found". */
  private async version(userId: string, projectId: string, versionId: string) {
    const access = await this.projects.access(userId, projectId);
    const since = await this.since(access.project.ownerId);
    const version = await this.prisma.client.projectVersion.findFirst({
      where: { id: versionId, ...this.visible(projectId, since) },
    });
    if (!version) return fail(HttpStatus.NOT_FOUND, 'not_found');
    return { ...access, version, manifest: await this.readManifest(version) };
  }

  async detail(userId: string, projectId: string, versionId: string): Promise<VersionDetail> {
    const { version, manifest } = await this.version(userId, projectId, versionId);
    const current = await this.prisma.client.projectFile.findMany({ where: { projectId } });
    const match = matcher(current);
    const matched = new Set<string>();
    return {
      version: (await this.summaries([version]))[0]!,
      files: manifest.files.map((file) => {
        const now = match(file);
        if (now) matched.add(now.id);
        return {
          path: file.path,
          kind: file.kind,
          sizeBytes: file.sizeBytes,
          change: !now
            ? 'removed'
            : now.path !== file.path
              ? 'moved'
              : blobOf(now) === file.blob
                ? 'same'
                : 'modified',
        };
      }),
      added: current
        .filter((file) => !matched.has(file.id))
        .map((file) => file.path)
        .sort(),
    };
  }

  /** Text of one file of a version (preview). */
  async fileText(
    userId: string,
    projectId: string,
    versionId: string,
    path: string,
  ): Promise<Uint8Array> {
    const { manifest } = await this.version(userId, projectId, versionId);
    const file = manifest.files.find((item) => item.path === path);
    if (!file) return fail(HttpStatus.NOT_FOUND, 'not_found');
    if (file.kind !== 'TEXT') fail(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'not_text');
    return file.blob
      ? this.storage.get(PROJECTS_BUCKET, blobKey(projectId, file.blob))
      : new Uint8Array();
  }

  // ───────────── Restoring ─────────────

  /**
   * Restores the whole project (files created since are removed, deleted ones come back) or
   * only `path`. The current state is saved as a version first; files locked by a validated
   * submission are left as they are.
   */
  async restore(
    userId: string,
    projectId: string,
    versionId: string,
    path: string | undefined,
    ip: string | null,
  ): Promise<RestoreResult> {
    await this.projects.require(userId, projectId, 'edit');
    const { project, version, manifest } = await this.version(userId, projectId, versionId);
    const targets = path ? manifest.files.filter((file) => file.path === path) : manifest.files;
    if (path && !targets.length) fail(HttpStatus.NOT_FOUND, 'not_found');
    await this.limit(userId);

    const result = await this.projects.runLocked(project.ownerId, async () => {
      const db = this.prisma.client;
      // Made read-only or trashed while waiting for the lock: nothing is written.
      const fresh = await db.project.findUnique({ where: { id: projectId } });
      if (!fresh || fresh.deletedAt) return fail(HttpStatus.NOT_FOUND, 'not_found');
      if (fresh.readOnlyReason) fail(HttpStatus.FORBIDDEN, 'read_only');

      const current = await db.projectFile.findMany({ where: { projectId } });
      const match = matcher(current);
      const kept: string[] = [];
      // Each file of the version: the current file it stands for (same id), if any.
      const pairs = targets.map((file) => ({ file, now: match(file) }));
      const claimed = new Set(pairs.flatMap(({ now }) => (now ? [now.id] : [])));
      const removals = path
        ? []
        : current.filter((file) => {
            if (claimed.has(file.id)) return false;
            if (file.lockedBySubmissionId) kept.push(file.path);
            return !file.lockedBySubmissionId;
          });
      const removedIds = new Set(removals.map((file) => file.id));

      // Locked files stay as they are; a single file is restored where it is now.
      const changes = pairs.filter(({ file, now }) => {
        if (!now) return true;
        const moves = !path && now.path !== file.path;
        if (!moves && blobOf(now) === file.blob) return false;
        if (now.lockedBySubmissionId) {
          kept.push(now.path);
          return false;
        }
        return true;
      });
      const changing = new Set(changes.flatMap(({ now }) => (now ? [now.id] : [])));
      const target = (file: ManifestFile, now: ProjectFile | undefined) =>
        now && path ? now.path : file.path;
      // Paths taken after the restoration: files left where they are first, then the others
      // in turn. A file whose path is taken (by a kept file, or as a folder) stays out.
      const taken = current
        .filter((file) => !removedIds.has(file.id) && !changing.has(file.id))
        .map((file) => file.path);
      // Kept empty folders stay, unless the whole version brings its own folders.
      const keptFolders =
        !path && manifest.folders
          ? []
          : (await db.projectFolder.findMany({ where: { projectId } })).map((row) => row.path);
      const applied = changes.filter(({ file, now }) => {
        const to = target(file, now);
        if (now?.path === to || !pathConflicts(taken, to, keptFolders)) {
          taken.push(to);
          return true;
        }
        if (now) taken.push(now.path);
        kept.push(file.path);
        return false;
      });

      const writes = applied.filter(({ file, now }) => !now || blobOf(now) !== file.blob);
      const added = writes.reduce((total, { file }) => total + file.sizeBytes, 0);
      const freed =
        writes.reduce((total, { now }) => total + (now?.sizeBytes ?? 0), 0) +
        removals.reduce((total, file) => total + file.sizeBytes, 0);
      if (added > freed) await this.projects.checkStorageFor(project.ownerId, added - freed);

      // Kept folders of the version (whole restoration of a version that records them).
      const folders =
        !path && manifest.folders
          ? manifest.folders.filter((folder) => !pathConflicts(taken, folder))
          : null;
      const folderCount =
        folders?.length ?? (await db.projectFolder.count({ where: { projectId } }));
      if (taken.length + folderCount > this.config.env.PROJECT_MAX_FILES) {
        fail(HttpStatus.CONFLICT, 'too_many_files');
      }

      // Nothing is lost: the state before the restoration becomes a version.
      await this.snapshot(projectId, 'AUTO', {
        userId,
        restoreOfId: version.id,
        restorePath: path ?? null,
      });

      const obsolete: string[] = [];
      const contents = new Map<ManifestFile, string>();
      for (const { file } of writes) {
        const storageKey = this.projects.newKey(projectId);
        if (file.blob) {
          await this.storage.copy(PROJECTS_BUCKET, blobKey(projectId, file.blob), storageKey);
        } else {
          await this.storage.put(PROJECTS_BUCKET, storageKey, new Uint8Array());
        }
        contents.set(file, storageKey);
      }
      const replaced: string[] = [];
      await db.$transaction(async (tx) => {
        if (removals.length) {
          await tx.projectFile.deleteMany({ where: { id: { in: [...removedIds] } } });
        }
        // Moved files are parked first: two files may swap their paths.
        const moving = applied.filter(({ file, now }) => now && now.path !== target(file, now));
        for (const { now } of moving) {
          await tx.projectFile.update({ where: { id: now!.id }, data: { path: parked(now!.id) } });
        }
        for (const { file, now } of applied) {
          const storageKey = contents.get(file);
          if (!now) {
            await tx.projectFile.create({
              data: {
                projectId,
                path: file.path,
                kind: file.kind,
                storageKey: storageKey!,
                sizeBytes: file.sizeBytes,
              },
            });
            continue;
          }
          await tx.projectFile.update({
            where: { id: now.id },
            data: {
              path: target(file, now),
              ...(storageKey ? { storageKey, sizeBytes: file.sizeBytes } : {}),
            },
          });
          if (storageKey) {
            if (now.storageKey) obsolete.push(now.storageKey);
            if (now.kind === 'TEXT') replaced.push(now.id);
          }
        }
        if (folders) {
          await tx.projectFolder.deleteMany({ where: { projectId } });
          await tx.projectFolder.createMany({
            data: folders.map((folder) => ({ projectId, path: folder })),
          });
        }
        const main = !path && taken.includes(manifest.mainFilePath) ? manifest.mainFilePath : null;
        await tx.project.update({
          where: { id: projectId },
          data: { lastActivityAt: new Date(), ...(main ? { mainFilePath: main } : {}) },
        });
      });
      obsolete.push(...removals.flatMap((file) => (file.storageKey ? [file.storageKey] : [])));
      for (const fileId of replaced) {
        await this.events.publish({ type: 'file-replaced', projectId, fileId });
      }
      for (const file of removals) {
        await this.events.publish({ type: 'file-deleted', projectId, fileId: file.id });
      }
      await this.events.publish({ type: 'files-changed', projectId });
      // History objects are separate copies: the replaced objects can go.
      await this.storage.deleteKeys(PROJECTS_BUCKET, obsolete).catch(() => undefined);
      return { restored: applied.length, removed: removals.length, kept: kept.sort() };
    });

    await this.events.changed(projectId);
    await this.prisma.client.auditLog.create({
      data: {
        actorId: userId,
        action: 'VERSION_RESTORED',
        targetType: 'Project',
        targetId: projectId,
        metadata: { versionId, path: path ?? null, ...result },
        ip,
      },
    });
    return result;
  }
}
