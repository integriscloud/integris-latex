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

/** A file in a version: its content is the history object `blob` (null for an empty file). */
export interface ManifestFile {
  path: string;
  kind: ProjectFile['kind'];
  sizeBytes: number;
  blob: string | null;
}

/** What a version holds, stored as JSON under the project prefix. */
export interface Manifest {
  mainFilePath: string;
  files: ManifestFile[];
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
  const blobs = new Map(b.files.map((file) => [file.path, file.blob]));
  return a.files.every((file) => blobs.has(file.path) && blobs.get(file.path) === file.blob);
};

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
    const manifest: Manifest = {
      mainFilePath: project.mainFilePath,
      files: files
        .map((file) => ({
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
    const byPath = new Map(current.map((file) => [file.path, file]));
    const paths = new Set(manifest.files.map((file) => file.path));
    return {
      version: (await this.summaries([version]))[0]!,
      files: manifest.files.map((file) => {
        const now = byPath.get(file.path);
        return {
          path: file.path,
          kind: file.kind,
          sizeBytes: file.sizeBytes,
          change: !now ? 'removed' : blobOf(now) === file.blob ? 'same' : 'modified',
        };
      }),
      added: current
        .filter((file) => !paths.has(file.path))
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
      const byPath = new Map(current.map((file) => [file.path, file]));
      const wanted = new Set(manifest.files.map((file) => file.path));
      const kept: string[] = [];
      const writes = targets.filter((file) => {
        const now = byPath.get(file.path);
        if (now && blobOf(now) === file.blob) return false;
        if (now?.lockedBySubmissionId) {
          kept.push(file.path);
          return false;
        }
        return true;
      });
      const removals = path
        ? []
        : current.filter((file) => {
            if (wanted.has(file.path)) return false;
            if (file.lockedBySubmissionId) kept.push(file.path);
            return !file.lockedBySubmissionId;
          });
      const removedPaths = new Set(removals.map((file) => file.path));
      // A file to bring back where a kept file now stands as a folder ("a.tex/…") stays out.
      const remaining = current.filter((file) => !removedPaths.has(file.path)).map((f) => f.path);
      const creatable = writes.filter((file) => {
        if (byPath.has(file.path)) return true;
        if (pathConflicts(remaining, file.path)) {
          kept.push(file.path);
          return false;
        }
        remaining.push(file.path);
        return true;
      });

      const added = creatable.reduce((total, file) => total + file.sizeBytes, 0);
      const freed =
        creatable.reduce((total, file) => total + (byPath.get(file.path)?.sizeBytes ?? 0), 0) +
        removals.reduce((total, file) => total + file.sizeBytes, 0);
      if (added > freed) await this.projects.checkStorageFor(project.ownerId, added - freed);
      if (remaining.length > this.config.env.PROJECT_MAX_FILES) {
        fail(HttpStatus.CONFLICT, 'too_many_files');
      }

      // Nothing is lost: the state before the restoration becomes a version.
      await this.snapshot(projectId, 'AUTO', {
        userId,
        restoreOfId: version.id,
        restorePath: path ?? null,
      });

      const obsolete: string[] = [];
      for (const file of creatable) {
        const storageKey = this.projects.newKey(projectId);
        if (file.blob) {
          await this.storage.copy(PROJECTS_BUCKET, blobKey(projectId, file.blob), storageKey);
        } else {
          await this.storage.put(PROJECTS_BUCKET, storageKey, new Uint8Array());
        }
        const now = byPath.get(file.path);
        if (now) {
          await db.projectFile.update({
            where: { id: now.id },
            data: { storageKey, sizeBytes: file.sizeBytes },
          });
          if (now.storageKey) obsolete.push(now.storageKey);
          if (now.kind === 'TEXT') {
            await this.events.publish({ type: 'file-replaced', projectId, fileId: now.id });
          }
        } else {
          await db.projectFile.create({
            data: {
              projectId,
              path: file.path,
              kind: file.kind,
              storageKey,
              sizeBytes: file.sizeBytes,
            },
          });
        }
      }
      if (removals.length) {
        await db.projectFile.deleteMany({ where: { id: { in: removals.map((file) => file.id) } } });
        obsolete.push(...removals.flatMap((file) => (file.storageKey ? [file.storageKey] : [])));
        for (const file of removals) {
          await this.events.publish({ type: 'file-deleted', projectId, fileId: file.id });
        }
      }
      const main =
        !path && remaining.includes(manifest.mainFilePath) ? manifest.mainFilePath : null;
      await db.project.update({
        where: { id: projectId },
        data: { lastActivityAt: new Date(), ...(main ? { mainFilePath: main } : {}) },
      });
      // History objects are separate copies: the replaced objects can go.
      await this.storage.deleteKeys(PROJECTS_BUCKET, obsolete).catch(() => undefined);
      return { restored: creatable.length, removed: removals.length, kept: kept.sort() };
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
