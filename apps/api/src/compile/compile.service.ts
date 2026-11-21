import type { Compilation as CompilationRow, CompilationStatus } from '@integris/db';
import {
  COMPILE_OUTPUT_BUCKET,
  COMPILE_PRIORITY_RANK,
  COMPILE_SOURCE_URL_SECONDS,
  type Compilation,
  type CompileIssue,
  compileOutputKey,
  compileOutputPrefix,
  type CompileOutcome,
  type CompileResult,
  type CompileState,
  PDF_LINK_SECONDS,
  PROJECTS_BUCKET,
  usageLevel,
} from '@integris/shared';
import {
  HttpStatus,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../common/api-error.js';
import { ApiConfig } from '../config/api-config.js';
import { downloadName, fileLinkKey, signFileLink } from '../files/file-links.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { fail, ProjectsService } from '../projects/projects.service.js';
import { compileHourKey as hourKey, QuotaService } from '../projects/quota.service.js';
import { UsageAlertsService } from '../projects/usage-alerts.service.js';
import { RedisService } from '../redis/redis.service.js';
import { StorageService } from '../storage/storage.service.js';
import {
  CompileQueueService,
  type QueuedJob,
  RENEW_URLS_AFTER_MS,
} from './compile-queue.service.js';

const HOUR_MS = 3600_000;

/**
 * Sliding one-hour window of the compilations charged to an owner (Redis sorted set scored by
 * time). Atomic: two requests at the same time cannot both take the last place. Returns
 * [1, 0] when added, [0, time of the oldest entry] when the hour is full.
 */
const TAKE_SLOT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - tonumber(ARGV[2]))
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {0, tonumber(oldest[2])}
end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return {1, 0}
`;

/** Result details stored in `Compilation.errors`. */
interface StoredResult {
  outcome: CompileOutcome;
  issues: CompileIssue[];
  errorCount: number;
  warningCount: number;
  pdfBytes: number | null;
  log: boolean;
  synctex: boolean;
}

const STATUS_OF: Record<CompileOutcome, CompilationStatus> = {
  success: 'SUCCEEDED',
  tex_errors: 'FAILED',
  no_pdf: 'FAILED',
  timeout: 'TIMED_OUT',
  memory: 'FAILED',
  output_too_large: 'FAILED',
  main_missing: 'FAILED',
  sources_unavailable: 'FAILED',
  internal: 'FAILED',
};

const OPEN: CompilationStatus[] = ['QUEUED', 'RUNNING'];

/** A job not seen in the queue this long after its creation is lost (Redis flushed, crash). */
const LOST_AFTER_MS = 60_000;

/** A file of a frozen version: its history object in the projects bucket. */
export interface FrozenSource {
  path: string;
  storageKey: string;
  sizeBytes: number;
}

/**
 * What the submissions and exam papers modules tell the compile service about the compilation
 * of a frozen version (registered at start, so neither module imports the other).
 */
export interface FrozenHooks {
  /** Sources of a queued compilation, to sign its URLs again; null when gone. */
  sources(frozenId: string): Promise<{ mainFile: string; files: FrozenSource[] } | null>;
  /** The compilation of a frozen version finished (once). */
  finished(row: CompilationRow): Promise<void>;
}

/** Frozen compilations: a submission version, or an exam subject sent to the secretariat. */
export type FrozenKind = 'submission' | 'print';

/** The frozen kind and id of a compilation, or null for the project's own compilations. */
function frozenOf(row: CompilationRow): { kind: FrozenKind; id: string } | null {
  if (row.submissionVersionId) return { kind: 'submission', id: row.submissionVersionId };
  if (row.printSendId) return { kind: 'print', id: row.printSendId };
  return null;
}

/** Only the project's own compilations: never the frozen ones of submissions and print sends. */
const PROJECT_ONLY = { submissionVersionId: null, printSendId: null };

/**
 * Compilations (docs/spec.md, "Compilation"): the owner and editors start them, usage is
 * charged to the project owner (duration and compilations per hour of their best plan,
 * priority in the queue), workers compile, and every role reads the result. PDFs are served by
 * signed links on the files domain; the log and the SyncTeX index by the API.
 */
@Injectable()
export class CompileService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CompileService.name);
  private readonly linkKey: Buffer;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private readonly frozenHooks = new Map<FrozenKind, FrozenHooks>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly quota: QuotaService,
    private readonly alerts: UsageAlertsService,
    private readonly storage: StorageService,
    private readonly redis: RedisService,
    private readonly queue: CompileQueueService,
    private readonly config: ApiConfig,
  ) {
    this.linkKey = fileLinkKey(config.env.AUTH_SECRET);
  }

  onModuleInit(): void {
    this.queue.listen({
      active: (id) => this.markRunning(id),
      completed: (id, result) => this.finish(id, result),
      failed: (id) => this.finish(id, null),
    });
    this.renewTimer = setInterval(() => {
      this.renewUrls().catch((error: unknown) =>
        this.logger.error({ err: (error as Error).message }, 'URL renewal failed'),
      );
    }, 60_000);
    this.renewTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.renewTimer) clearInterval(this.renewTimer);
  }

  registerFrozen(kind: FrozenKind, hooks: FrozenHooks): void {
    this.frozenHooks.set(kind, hooks);
  }

  // ───────────── Starting ─────────────

  /** Queues a compilation of the project as it is stored now. */
  async start(userId: string, projectId: string, auto: boolean): Promise<Compilation> {
    const { project, rights } = await this.projects.require(userId, projectId, 'edit');
    const quotas = await this.quota.quotas(project.ownerId);
    if (auto && !quotas.autoCompile) fail(HttpStatus.FORBIDDEN, 'auto_compile_unavailable');

    const db = this.prisma.client;
    const files = await db.projectFile.findMany({ where: { projectId } });
    const main = files.find((file) => file.path === project.mainFilePath);
    if (!main || !main.path.toLowerCase().endsWith('.tex')) {
      fail(HttpStatus.UNPROCESSABLE_ENTITY, 'main_missing');
    }

    // A compilation still waiting for this project is replaced by the new one (and not charged).
    const waiting = await db.compilation.findMany({
      where: { projectId, status: 'QUEUED', ...PROJECT_ONLY },
    });
    for (const previous of waiting) {
      if (await this.queue.cancel(previous.id)) {
        await db.compilation.updateMany({
          where: { id: previous.id, status: 'QUEUED' },
          data: { status: 'CANCELED', finishedAt: new Date() },
        });
        await this.redis.client.zrem(hourKey(project.ownerId), previous.id);
      }
    }

    const id = randomUUID();
    const now = Date.now();
    const [taken, oldest] = (await this.redis.client.eval(
      TAKE_SLOT,
      1,
      hourKey(project.ownerId),
      now,
      HOUR_MS,
      quotas.maxCompilesPerHour,
      id,
    )) as [number, number];
    if (!taken) {
      throw new ApiError(
        HttpStatus.TOO_MANY_REQUESTS,
        'compile_limit',
        Math.max(1, Math.ceil((oldest + HOUR_MS - now) / 1000)),
      );
    }

    try {
      const row = await db.compilation.create({
        data: {
          id,
          projectId,
          triggeredById: userId,
          chargedUserId: project.ownerId,
          engine: project.engine,
          priority: quotas.compilePriority,
          status: 'QUEUED',
        },
      });
      await this.queue.add(
        {
          compilationId: id,
          projectId,
          engine: project.engine,
          mainFile: project.mainFilePath,
          timeoutSeconds: quotas.maxCompileSeconds,
          cache: true,
          files: await this.signFiles(files),
          signedAt: now,
        },
        COMPILE_PRIORITY_RANK[quotas.compilePriority],
      );
      this.alerts.check(project.ownerId);
      return this.view(row, quotas.maxCompileSeconds, project.name, rights.read);
    } catch (error) {
      await this.redis.client.zrem(hourKey(project.ownerId), id);
      await db.compilation
        .updateMany({ where: { id, status: 'QUEUED' }, data: { status: 'FAILED' } })
        .catch(() => undefined);
      this.logger.error({ err: (error as Error).message, projectId }, 'Compilation not queued');
      throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'compile_unavailable');
    }
  }

  /**
   * Queues the compilation of a frozen version: a submission version (docs/spec.md,
   * "Encadrement") or an exam subject sent to the secretariat. Its frozen sources, without the
   * project's cache, within the duration of the owner's plan. It is charged to the owner like any
   * compilation (counted in the statistics) but never takes a place of the hourly limit: a
   * student is never kept from sending before a deadline. Sendings have their own limits. The
   * caller has checked the rights.
   */
  async startFrozen(input: {
    projectId: string;
    ownerId: string;
    userId: string;
    engine: CompilationRow['engine'];
    frozen: { submissionVersionId: string } | { printSendId: string };
    mainFile: string;
    files: FrozenSource[];
  }): Promise<CompilationRow> {
    const quotas = await this.quota.quotas(input.ownerId);
    const db = this.prisma.client;
    const id = randomUUID();
    const row = await db.compilation.create({
      data: {
        id,
        projectId: input.projectId,
        triggeredById: input.userId,
        chargedUserId: input.ownerId,
        engine: input.engine,
        priority: quotas.compilePriority,
        status: 'QUEUED',
        ...input.frozen,
      },
    });
    try {
      await this.queue.add(
        {
          compilationId: id,
          projectId: input.projectId,
          engine: input.engine,
          mainFile: input.mainFile,
          timeoutSeconds: quotas.maxCompileSeconds,
          cache: false,
          files: await this.signFiles(input.files),
          signedAt: Date.now(),
        },
        COMPILE_PRIORITY_RANK[quotas.compilePriority],
      );
    } catch (error) {
      await db.compilation
        .updateMany({ where: { id, status: 'QUEUED' }, data: { status: 'FAILED' } })
        .catch(() => undefined);
      this.logger.error(
        { err: (error as Error).message, projectId: input.projectId },
        'Frozen compilation not queued',
      );
      throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'compile_unavailable');
    }
    return row;
  }

  /**
   * Finishes a compilation of a submission version whose worker event was missed (or whose job
   * was lost). Only open compilations are looked at: the others are final.
   */
  async refreshFrozen(row: CompilationRow, ownerId: string): Promise<CompilationRow> {
    if (!OPEN.includes(row.status)) return row;
    const quotas = await this.quota.quotas(ownerId);
    return this.refresh(row, quotas.maxCompileSeconds);
  }

  /** What a compilation of a frozen version shows: PDF links, errors. */
  frozenView(row: CompilationRow, projectName: string): Promise<Compilation> {
    return this.view(row, null, projectName, true);
  }

  /** Deletes the outputs of a compilation (a draft submission deleted with its failed sendings). */
  async dropOutputs(projectId: string, compilationId: string): Promise<void> {
    await this.storage.deletePrefix(
      COMPILE_OUTPUT_BUCKET,
      compileOutputPrefix(projectId, compilationId),
    );
  }

  /** Presigned GET URLs of the project files, one per file, valid 5 minutes. */
  private signFiles(
    files: { path: string; storageKey: string | null; sizeBytes: number }[],
  ): Promise<QueuedJob['files']> {
    return Promise.all(
      files
        .filter((file) => file.storageKey)
        .map(async (file) => ({
          path: file.path,
          size: file.sizeBytes,
          url: await this.storage.presignGet(
            PROJECTS_BUCKET,
            file.storageKey!,
            COMPILE_SOURCE_URL_SECONDS,
          ),
        })),
    );
  }

  /**
   * Jobs still waiting get new URLs before theirs expire. Job data lives in Redis, where a
   * compilation worker can write: nothing is taken from it. Each job is rebuilt from its
   * `Compilation` row (still queued), the project and the owner's plan, so a forged or edited job
   * never gets URLs of another project.
   */
  async renewUrls(now = Date.now()): Promise<number> {
    const db = this.prisma.client;
    const stale = await this.queue.stale(now - RENEW_URLS_AFTER_MS);
    let renewed = 0;
    for (const { id } of stale) {
      const row = await db.compilation.findUnique({ where: { id } });
      if (!row || row.status !== 'QUEUED') continue;
      const project = await db.project.findUnique({ where: { id: row.projectId } });
      if (!project || project.deletedAt) continue;
      const quotas = await this.quota.quotas(row.chargedUserId);
      // A frozen version compiles its frozen files, read again from the database.
      const which = frozenOf(row);
      const frozen = which ? await this.frozenHooks.get(which.kind)?.sources(which.id) : null;
      if (which && !frozen) continue;
      const files = frozen
        ? frozen.files
        : await db.projectFile.findMany({ where: { projectId: row.projectId } });
      await this.queue.updateData(id, {
        compilationId: id,
        projectId: row.projectId,
        engine: row.engine,
        mainFile: frozen ? frozen.mainFile : project.mainFilePath,
        timeoutSeconds: quotas.maxCompileSeconds,
        cache: !frozen,
        files: await this.signFiles(files),
        signedAt: now,
      });
      renewed++;
    }
    return renewed;
  }

  // ───────────── Worker events ─────────────

  async markRunning(id: string): Promise<void> {
    await this.prisma.client.compilation.updateMany({
      where: { id, status: 'QUEUED' },
      data: { status: 'RUNNING', startedAt: new Date() },
    });
  }

  /** Stores the result of a job (null: the worker crashed). Idempotent. */
  async finish(id: string, result: CompileResult | null): Promise<void> {
    const db = this.prisma.client;
    const row = await db.compilation.findUnique({ where: { id } });
    if (!row || !OPEN.includes(row.status)) return;
    const outcome = result?.outcome ?? 'internal';
    const stored: StoredResult = {
      outcome,
      issues: result?.issues ?? [],
      errorCount: result?.errorCount ?? 0,
      warningCount: result?.warningCount ?? 0,
      pdfBytes: result?.pdfBytes ?? null,
      log: result?.log ?? false,
      synctex: result?.synctex ?? false,
    };
    const finishedAt = new Date();
    const updated = await db.compilation.updateMany({
      where: { id, status: { in: OPEN } },
      data: {
        status: STATUS_OF[outcome],
        finishedAt,
        startedAt: row.startedAt ?? finishedAt,
        durationMs: result?.durationMs ?? null,
        errors: stored as object,
        pdfKey: stored.pdfBytes ? compileOutputKey(row.projectId, id, 'pdf') : null,
        logKey: stored.log ? compileOutputKey(row.projectId, id, 'log') : null,
        workerHost: result?.worker ?? null,
      },
    });
    if (!updated.count) return;
    // Every compilation that ran is counted on the owner, submission versions included.
    await this.quota
      .chargeCompilation(
        row.chargedUserId,
        result?.durationMs ?? finishedAt.getTime() - (row.startedAt ?? finishedAt).getTime(),
        finishedAt,
      )
      .catch((error: unknown) =>
        this.logger.error({ err: (error as Error).message, id }, 'Usage not counted'),
      );
    await this.queue.forget(id);
    const which = frozenOf(row);
    if (which) {
      const done = await db.compilation.findUnique({ where: { id } });
      const hooks = this.frozenHooks.get(which.kind);
      if (done && hooks) await hooks.finished(done);
      return;
    }
    await this.dropOldOutputs(row.projectId);
  }

  /**
   * Keeps the outputs of the last compilation, of the last PDF and of the last success only. The
   * PDFs of submission versions are kept with their submission.
   */
  private async dropOldOutputs(projectId: string): Promise<void> {
    const db = this.prisma.client;
    const finished = await db.compilation.findMany({
      where: {
        projectId,
        ...PROJECT_ONLY,
        OR: [{ pdfKey: { not: null } }, { logKey: { not: null } }],
      },
      orderBy: { queuedAt: 'desc' },
    });
    const lastPdf = finished.find((row) => row.pdfKey);
    // The last successful PDF is also what public links show.
    const lastSucceeded = finished.find((row) => row.pdfKey && row.status === 'SUCCEEDED');
    const keep = new Set([finished[0]?.id, lastPdf?.id, lastSucceeded?.id]);
    for (const row of finished) {
      if (keep.has(row.id)) continue;
      await this.storage.deletePrefix(
        COMPILE_OUTPUT_BUCKET,
        compileOutputPrefix(projectId, row.id),
      );
      await db.compilation.update({ where: { id: row.id }, data: { pdfKey: null, logKey: null } });
    }
  }

  // ───────────── Reading ─────────────

  /** The last compilation and the last PDF of a project, and what the user may do. */
  async state(userId: string, projectId: string): Promise<CompileState> {
    const { project, rights } = await this.projects.access(userId, projectId);
    const quotas = await this.quota.quotas(project.ownerId);
    const db = this.prisma.client;
    const [current, lastPdf] = await Promise.all([
      db.compilation.findFirst({
        where: { projectId, status: { not: 'CANCELED' }, ...PROJECT_ONLY },
        orderBy: { queuedAt: 'desc' },
      }),
      db.compilation.findFirst({
        where: { projectId, pdfKey: { not: null }, ...PROJECT_ONLY },
        orderBy: { queuedAt: 'desc' },
      }),
    ]);
    const refreshed = current ? await this.refresh(current, quotas.maxCompileSeconds) : null;
    // The plan of the owner is told to the owner and editors only.
    const shown = rights.edit ? quotas.maxCompileSeconds : null;
    return {
      current: refreshed ? await this.view(refreshed, shown, project.name, rights.read) : null,
      lastPdf: lastPdf ? await this.view(lastPdf, shown, project.name, rights.read) : null,
      canCompile: rights.edit && !project.readOnlyReason,
      autoCompile: rights.edit && quotas.autoCompile,
      maxSeconds: shown,
      maxPerHour: rights.edit ? quotas.maxCompilesPerHour : null,
      usedThisHour: rights.edit ? (await this.quota.compilesThisHour(project.ownerId)).used : null,
      // The owner's storage is told to the owner only (alerts at 80 % and 100 %).
      storageLevel: rights.manage
        ? usageLevel(
            Number(await this.quota.storageUsed(project.ownerId)),
            Number(quotas.storageBytes),
          )
        : null,
    };
  }

  /** One compilation, polled by the editor while it is queued or running. */
  async one(userId: string, projectId: string, id: string): Promise<Compilation> {
    const { project, rights } = await this.projects.access(userId, projectId);
    const row = await this.row(projectId, id, true);
    const quotas = await this.quota.quotas(project.ownerId);
    const refreshed = await this.refresh(row, quotas.maxCompileSeconds);
    return this.view(
      refreshed,
      rights.edit ? quotas.maxCompileSeconds : null,
      project.name,
      rights.read,
    );
  }

  /**
   * A compilation of the project. Read for a user (`one`, `output`), never one of a print send:
   * the frozen exam subject is only served by the secretariat screens (step 13).
   */
  private async row(projectId: string, id: string, forUser = false): Promise<CompilationRow> {
    const row = await this.prisma.client.compilation.findFirst({
      where: { id, projectId, ...(forUser ? { printSendId: null } : {}) },
    });
    return row ?? fail(HttpStatus.NOT_FOUND, 'not_found');
  }

  /** Finishes a compilation whose worker event was missed, or whose job was lost. */
  private async refresh(row: CompilationRow, maxSeconds: number): Promise<CompilationRow> {
    if (!OPEN.includes(row.status)) return row;
    const status = await this.queue.status(row.id);
    const age = Date.now() - row.queuedAt.getTime();
    if (status.state === 'completed') {
      await this.finish(row.id, status.result);
    } else if (status.state === 'failed') {
      await this.finish(row.id, null);
    } else if (status.state === 'missing' && age > LOST_AFTER_MS) {
      await this.finish(row.id, null);
    } else if (status.state === 'active' && row.status === 'QUEUED') {
      await this.markRunning(row.id);
    } else if (age > (maxSeconds + 3600) * 1000) {
      // Waiting or running for an hour beyond the plan's duration: given up.
      await this.queue.cancel(row.id);
      await this.finish(row.id, null);
    } else {
      return row;
    }
    return this.row(row.projectId, row.id);
  }

  /** Short-lived signed links of a PDF on the files domain (shown, and downloaded). */
  private pdfLinks(pdfKey: string, projectName: string) {
    const expires = Math.floor(Date.now() / 1000) + PDF_LINK_SECONDS;
    const name = downloadName(projectName);
    const base = this.config.env.FILES_PUBLIC_URL.replace(/\/+$/, '');
    const link = (download: boolean) =>
      `${base}/pdf/${signFileLink(this.linkKey, { key: pdfKey, expires, download })}/${name}`;
    return {
      url: link(false),
      downloadUrl: link(true),
      expiresAt: new Date(expires * 1000).toISOString(),
    };
  }

  /** PDF of the last successful compilation, for a public link (no account, no compilation). */
  async publicPdf(projectId: string, projectName: string) {
    const row = await this.prisma.client.compilation.findFirst({
      where: { projectId, status: 'SUCCEEDED', pdfKey: { not: null }, ...PROJECT_ONLY },
      orderBy: { queuedAt: 'desc' },
    });
    if (!row?.pdfKey) return null;
    const { url, downloadUrl } = this.pdfLinks(row.pdfKey, projectName);
    return { url, downloadUrl };
  }

  private async view(
    row: CompilationRow,
    /** Null for the roles that do not edit: the plan of the owner is not told to them. */
    maxSeconds: number | null,
    projectName: string,
    canRead: boolean,
  ): Promise<Compilation> {
    const stored = (row.errors ?? null) as StoredResult | null;
    let pdf: Compilation['pdf'] = null;
    if (row.pdfKey && canRead) {
      pdf = { ...this.pdfLinks(row.pdfKey, projectName), bytes: stored?.pdfBytes ?? 0 };
    }
    return {
      id: row.id,
      status: row.status,
      engine: row.engine,
      outcome: stored?.outcome ?? null,
      queuedAt: row.queuedAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      durationMs: row.durationMs,
      position: row.status === 'QUEUED' ? ((await this.queue.position(row.id)) ?? 1) : null,
      maxSeconds,
      issues: stored?.issues ?? [],
      errorCount: stored?.errorCount ?? 0,
      warningCount: stored?.warningCount ?? 0,
      pdf,
      log: Boolean(row.logKey),
      synctex: Boolean(row.pdfKey && stored?.synctex),
    };
  }

  /** Raw log or SyncTeX index of a compilation, for any role of the project. */
  async output(userId: string, projectId: string, id: string, file: 'log' | 'synctex') {
    await this.projects.access(userId, projectId);
    const row = await this.row(projectId, id, true);
    const stored = (row.errors ?? null) as StoredResult | null;
    const present = file === 'log' ? row.logKey : row.pdfKey && stored?.synctex;
    const object = present
      ? await this.storage.open(COMPILE_OUTPUT_BUCKET, compileOutputKey(projectId, id, file))
      : null;
    return object ?? fail(HttpStatus.NOT_FOUND, 'no_output');
  }
}
