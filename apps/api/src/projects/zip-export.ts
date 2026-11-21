import type { ProjectFile } from '@integris/db';
import { type ArchiveGrant, PROJECTS_BUCKET } from '@integris/shared';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { consumeLimit } from '../common/rate-limit.js';
import { ApiConfig } from '../config/api-config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { StorageService } from '../storage/storage.service.js';
import { type Actor, ProjectAuditService } from './project-audit.service.js';
import { fail, ProjectsService } from './projects.service.js';

// Long enough to read the warning shown before a large download.
const GRANT_SECONDS = 300;
const LOCK_MS = 60_000;
const RENEW_MS = 20_000;
// A client that reads nothing for this long is cut: it never holds the project lock forever.
const IDLE_MS = 60_000;
// Local header (30) + data descriptor (16) + central header (46) per entry, name twice.
const ENTRY_OVERHEAD = 92;
const END_OVERHEAD = 22;

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`;
const EXTEND = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) end return 0`;

const grantKey = (token: string) =>
  `archive:grant:${createHash('sha256').update(token).digest('hex')}`;
const lockKey = (projectId: string) => `lock:archive:${projectId}`;

/** Name of the downloaded file: the project name without characters awkward in a file name. */
export function archiveFileName(projectName: string): string {
  const clean = projectName
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${clean || 'project'}.zip`;
}

/**
 * Download of a whole project as a ZIP archive (docs/spec.md, "Téléchargement ZIP"): owner and
 * editors only, never refused for its size, streamed from storage to the response (nothing held
 * in memory or written to disk). At most ZIP_EXPORTS_PER_HOUR per account and one at a time per
 * project. A project beyond a limit of the ZIP import gets a warning before the download.
 */
@Injectable()
export class ProjectArchiveService {
  private readonly logger = new Logger(ProjectArchiveService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly projects: ProjectsService,
    private readonly redis: RedisService,
    private readonly config: ApiConfig,
    private readonly audit: ProjectAuditService,
  ) {}

  /** Owner and editors, read-only projects included (reading is not editing). */
  private async check(userId: string, projectId: string) {
    const access = await this.projects.access(userId, projectId);
    if (!access.rights.download) fail(HttpStatus.FORBIDDEN, 'forbidden');
    return access;
  }

  /** Counts the download and gives a token valid five minutes for `GET :id/archive`. */
  async grant(userId: string, projectId: string): Promise<ArchiveGrant> {
    await this.check(userId, projectId);
    if (await this.redis.client.exists(lockKey(projectId))) {
      fail(HttpStatus.CONFLICT, 'download_in_progress');
    }
    const { env } = this.config;
    await consumeLimit(this.redis.client, `rl:export:${userId}`, env.ZIP_EXPORTS_PER_HOUR, 3600);
    const token = randomBytes(32).toString('base64url');
    await this.redis.client.set(
      grantKey(token),
      JSON.stringify({ userId, projectId }),
      'EX',
      GRANT_SECONDS,
    );
    return { token, tooLargeForImport: await this.tooLargeForImport(projectId) };
  }

  /**
   * Whether the archive would be refused by the ZIP import: entries, bytes once extracted, or
   * archive size. The archive size is overestimated (files counted uncompressed).
   */
  private async tooLargeForImport(projectId: string): Promise<boolean> {
    const { env } = this.config;
    const [files, folders] = await Promise.all([
      this.prisma.client.projectFile.findMany({ where: { projectId } }),
      this.prisma.client.projectFolder.findMany({ where: { projectId } }),
    ]);
    const bytes = files.reduce((total, file) => total + file.sizeBytes, 0);
    const names = [...files, ...folders].reduce(
      (total, entry) => total + ENTRY_OVERHEAD + 2 * Buffer.byteLength(entry.path) + 2,
      0,
    );
    return (
      files.length + folders.length > env.ZIP_MAX_FILES ||
      bytes > env.ZIP_MAX_TOTAL_BYTES ||
      bytes + names + END_OVERHEAD > env.ZIP_MAX_ARCHIVE_BYTES
    );
  }

  /** Streams the archive for a token given by `grant` (single use, same user and project). */
  async send(actor: Actor, projectId: string, token: string, response: Response): Promise<void> {
    const userId = actor.userId!;
    const granted = await this.redis.client.getdel(grantKey(token));
    const grant = granted ? (JSON.parse(granted) as { userId: string; projectId: string }) : null;
    if (grant?.userId !== userId || grant.projectId !== projectId) {
      fail(HttpStatus.GONE, 'download_expired');
    }
    const { project } = await this.check(userId, projectId);

    const lock = randomUUID();
    const taken = await this.redis.client.set(lockKey(projectId), lock, 'PX', LOCK_MS, 'NX');
    if (taken !== 'OK') fail(HttpStatus.CONFLICT, 'download_in_progress');
    const renew = setInterval(() => {
      void this.redis.client
        .eval(EXTEND, 1, lockKey(projectId), lock, LOCK_MS)
        .catch((error: unknown) =>
          this.logger.warn({ err: error, projectId }, 'Archive lock renewal failed'),
        );
    }, RENEW_MS);
    // A cancelled download only emits 'close': every wait on the response stops with it.
    const gone = new AbortController();
    response.once('close', () => gone.abort());
    response.setTimeout(IDLE_MS, () => response.destroy());
    try {
      const [files, folders] = await Promise.all([
        this.prisma.client.projectFile.findMany({ where: { projectId }, orderBy: { path: 'asc' } }),
        this.prisma.client.projectFolder.findMany({ where: { projectId } }),
      ]);
      const bytes = files.reduce((total, file) => total + file.sizeBytes, 0);
      await this.prisma.client.$transaction((tx) =>
        this.audit.write(tx, actor, 'PROJECT_DOWNLOADED', projectId, {
          files: files.length,
          folders: folders.length,
          bytes,
        }),
      );
      const name = archiveFileName(project.name);
      response.status(200).set({
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cross-Origin-Resource-Policy': 'same-origin',
        // Nginx passes the stream through instead of buffering it to a temporary file.
        'X-Accel-Buffering': 'no',
      });
      await this.write(
        projectId,
        files,
        folders.map((folder) => folder.path),
        response,
        gone.signal,
      );
    } catch (error) {
      if (!response.headersSent) throw error;
      // The archive is cut: the browser reports a failed download.
      this.logger.warn({ err: error, projectId }, 'Archive download interrupted');
      response.destroy();
    } finally {
      clearInterval(renew);
      await this.redis.client.eval(RELEASE, 1, lockKey(projectId), lock);
    }
  }

  /** Writes the entries one after the other, waiting whenever the response is full. */
  private async write(
    projectId: string,
    files: ProjectFile[],
    folders: string[],
    response: Response,
    signal: AbortSignal,
  ): Promise<void> {
    let failure = null as Error | null;
    const zip = new Zip((error, chunk, final) => {
      if (error) {
        failure = error;
        return;
      }
      response.write(chunk);
      if (final) response.end();
    });
    const drained = async () => {
      if (failure) throw failure;
      if (response.destroyed) throw new Error('Client gone');
      if (response.writableNeedDrain) await once(response, 'drain', { signal });
    };

    for (const file of files) {
      const entry =
        file.kind === 'TEXT'
          ? new ZipDeflate(file.path, { level: 6 })
          : new ZipPassThrough(file.path);
      entry.mtime = file.updatedAt;
      zip.add(entry);
      const object = await this.open(projectId, file);
      if (object) {
        try {
          for await (const chunk of object) {
            entry.push(chunk as Uint8Array);
            await drained();
          }
        } finally {
          object.destroy();
        }
      }
      entry.push(new Uint8Array(), true);
      await drained();
    }
    for (const folder of folders) {
      const entry = new ZipPassThrough(`${folder}/`);
      zip.add(entry);
      entry.push(new Uint8Array(), true);
    }
    zip.end();
    await drained();
    if (!response.writableFinished) await once(response, 'finish', { signal });
  }

  /**
   * The stored object of a file. A write may replace it while the archive is built: the file is
   * read again once; a file deleted meanwhile is written empty.
   */
  private async open(projectId: string, file: ProjectFile) {
    const opened = file.storageKey
      ? await this.storage.open(PROJECTS_BUCKET, file.storageKey)
      : null;
    if (opened || !file.storageKey) return opened?.body ?? null;
    const again = await this.prisma.client.projectFile.findFirst({
      where: { id: file.id, projectId },
    });
    if (!again?.storageKey) return null;
    return (await this.storage.open(PROJECTS_BUCKET, again.storageKey))?.body ?? null;
  }
}
