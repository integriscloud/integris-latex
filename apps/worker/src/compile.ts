import {
  COMPILE_CACHE_BUCKET,
  COMPILE_OUTPUT_BUCKET,
  type CompileJob,
  compileCacheKey,
  compileJobSchema,
  type CompileOutcome,
  compileOutputKey,
  type CompileResult,
  normalizeProjectPath,
  parseLatexLog,
  type WorkerEnv,
} from '@integris/shared';
import type { Job } from 'bullmq';
import { gzipSync } from 'node:zlib';
import type { Logger } from 'pino';
import type { SandboxLimits, SandboxRequest, SandboxRun } from './sandbox.js';
import { downloadSources, SourcesError } from './sources.js';
import { buildSynctexIndex } from './synctex.js';
import { readTar, type TarEntry, writeTar } from './tar.js';
import type { WorkerStorage } from './storage.js';

/** Intermediate files restored before the next compilation (docs/spec.md, "Cache"). */
const CACHE_EXTENSIONS = [
  '.aux',
  '.bbl',
  '.bcf',
  '.blg',
  '.toc',
  '.lof',
  '.lot',
  '.out',
  '.idx',
  '.ind',
  '.ilg',
  '.nav',
  '.snm',
  '.run.xml',
  '.fls',
  '.fdb_latexmk',
];
const MAX_CACHE_BYTES = 50 * 1024 * 1024;
/** Log kept for the raw view: its beginning and its end when longer. */
const MAX_LOG_BYTES = 4 * 1024 * 1024;
/** Free space under which the working directory is considered full (output too large). */
const FULL_WORKDIR_KB = 2048;

export interface CompileDependencies {
  env: WorkerEnv;
  storage: Pick<WorkerStorage, 'get' | 'put' | 'delete'>;
  runSandbox: (limits: SandboxLimits, request: SandboxRequest) => Promise<SandboxRun>;
  logger: Logger;
  workerName: string;
}

const isCacheFile = (path: string) =>
  CACHE_EXTENSIONS.some((extension) => path.endsWith(extension));

/** Job name of the main file: TeX writes `<job>.pdf` and `<job>.log` in the working directory. */
const jobNameOf = (mainFile: string) =>
  mainFile.slice(mainFile.lastIndexOf('/') + 1).replace(/\.tex$/i, '');

function shortenLog(log: Buffer): Buffer {
  if (log.length <= MAX_LOG_BYTES) return log;
  const head = log.subarray(0, MAX_LOG_BYTES / 4);
  const tail = log.subarray(log.length - (MAX_LOG_BYTES * 3) / 4);
  return Buffer.concat([head, Buffer.from('\n\n[…]\n\n'), tail]);
}

/** Cache entries of the previous compilation that may go back into the working directory. */
async function readCache(
  deps: CompileDependencies,
  projectId: string,
  sources: ReadonlySet<string>,
): Promise<TarEntry[]> {
  const archive = await deps.storage.get(
    COMPILE_CACHE_BUCKET,
    compileCacheKey(projectId),
    MAX_CACHE_BYTES,
  );
  if (!archive) return [];
  try {
    return readTar(archive, { maxEntries: 2000, maxEntryBytes: MAX_CACHE_BYTES }).filter(
      (entry) =>
        normalizeProjectPath(entry.name) === entry.name &&
        isCacheFile(entry.name) &&
        !sources.has(entry.name),
    );
  } catch {
    return [];
  }
}

function emptyResult(outcome: CompileOutcome, worker: string, durationMs = 0): CompileResult {
  return {
    outcome,
    durationMs,
    issues: [],
    errorCount: 0,
    warningCount: 0,
    pdfBytes: null,
    log: false,
    synctex: false,
    worker,
  };
}

/**
 * Compiles one job: downloads the project files through their presigned URLs, adds the cache,
 * runs latexmk in a disposable gVisor container, then stores the PDF, the log and the SyncTeX
 * index in compile-output and the new cache in compile-cache. Every failure of the document
 * (errors, time, memory, size) is a result, never an exception: the API shows it to the user.
 */
export async function compile(deps: CompileDependencies, data: unknown): Promise<CompileResult> {
  const { env, storage, logger, workerName } = deps;
  const parsed = compileJobSchema.safeParse(data);
  if (!parsed.success) {
    logger.error('invalid compile job data');
    return emptyResult('internal', workerName);
  }
  const job: CompileJob = parsed.data;
  const log = logger.child({ compilationId: job.compilationId, projectId: job.projectId });

  const main = job.files.find((file) => file.path === job.mainFile);
  if (!main || !/\.tex$/i.test(job.mainFile)) return emptyResult('main_missing', workerName);

  let sources: TarEntry[];
  try {
    sources = await downloadSources(job, {
      minioOrigin: new URL(env.MINIO_ENDPOINT).origin,
      // Room left for the results in the working directory.
      maxTotalBytes: (env.COMPILE_WORKDIR_MB * 1024 * 1024) / 2,
    });
  } catch (error) {
    if (!(error instanceof SourcesError)) throw error;
    log.warn({ reason: error.reason, detail: error.message }, 'sources refused');
    return emptyResult(error.reason === 'invalid' ? 'internal' : 'sources_unavailable', workerName);
  }
  const cache = await readCache(deps, job.projectId, new Set(sources.map((entry) => entry.name)));

  const run = await deps.runSandbox(env, {
    id: job.compilationId,
    worker: workerName,
    engine: job.engine,
    mainFile: job.mainFile,
    seconds: job.timeoutSeconds,
    input: writeTar([...sources, ...cache]),
  });
  log.info(
    { result: run.kind, durationMs: 'durationMs' in run ? run.durationMs : null },
    'sandbox done',
  );

  const cacheKey = compileCacheKey(job.projectId);
  if (run.kind !== 'finished') {
    // A cut run may leave inconsistent intermediate files: the next one starts clean.
    await storage.delete(COMPILE_CACHE_BUCKET, cacheKey);
    if (run.kind === 'failed') {
      log.error({ detail: run.detail }, 'sandbox failed');
      return emptyResult('internal', workerName);
    }
    return emptyResult(run.kind, workerName, run.durationMs);
  }

  const jobName = jobNameOf(job.mainFile);
  const results = new Map(run.files.map((entry) => [entry.name.slice('work/'.length), entry.data]));
  const pdf = results.get(`${jobName}.pdf`);
  const texLog = results.get(`${jobName}.log`);
  const synctex = results.get(`${jobName}.synctex.gz`);

  const parsedLog = texLog
    ? parseLatexLog(Buffer.from(texLog).toString('utf8'))
    : { issues: [], errorCount: 0, warningCount: 0 };
  const full = run.freeKb < FULL_WORKDIR_KB;
  const tooLarge = full || (pdf !== undefined && pdf.length > env.COMPILE_MAX_PDF_MB * 1024 * 1024);
  const outcome: CompileOutcome = tooLarge
    ? 'output_too_large'
    : !pdf || pdf.length === 0
      ? parsedLog.errorCount
        ? 'tex_errors'
        : 'no_pdf'
      : parsedLog.errorCount || run.exitCode !== 0
        ? 'tex_errors'
        : 'success';

  const keep = !tooLarge && pdf !== undefined && pdf.length > 0;
  if (keep) {
    await storage.put(
      COMPILE_OUTPUT_BUCKET,
      compileOutputKey(job.projectId, job.compilationId, 'pdf'),
      pdf,
      'application/pdf',
    );
  }
  if (texLog) {
    await storage.put(
      COMPILE_OUTPUT_BUCKET,
      compileOutputKey(job.projectId, job.compilationId, 'log'),
      shortenLog(Buffer.from(texLog)),
      'text/plain; charset=utf-8',
    );
  }
  const index = keep && synctex ? buildSynctexIndex(synctex) : null;
  if (index) {
    await storage.put(
      COMPILE_OUTPUT_BUCKET,
      compileOutputKey(job.projectId, job.compilationId, 'synctex'),
      gzipSync(JSON.stringify(index)),
      'application/json',
      'gzip',
    );
  }

  if (outcome === 'success') {
    const cacheEntries = [...results]
      .filter(([path]) => normalizeProjectPath(path) === path && isCacheFile(path))
      .map(([name, data]) => ({ name, data }));
    const archive = writeTar(cacheEntries);
    if (archive.length <= MAX_CACHE_BYTES) {
      await storage.put(COMPILE_CACHE_BUCKET, cacheKey, archive, 'application/x-tar');
    }
  } else {
    await storage.delete(COMPILE_CACHE_BUCKET, cacheKey);
  }

  return {
    outcome,
    durationMs: run.durationMs,
    issues: parsedLog.issues,
    errorCount: parsedLog.errorCount,
    warningCount: parsedLog.warningCount,
    pdfBytes: keep ? pdf.length : null,
    log: texLog !== undefined,
    synctex: index !== null,
    worker: workerName,
  };
}

/** BullMQ processor. The job's data is never logged: it holds presigned URLs. */
export function createCompileProcessor(deps: CompileDependencies) {
  return (job: Job): Promise<CompileResult> => compile(deps, job.data);
}
