import { z } from 'zod';
import { COMPILE_ISSUE_IDS } from './compile-log.js';
import { PATH_LIMITS } from './projects.js';
import { MAX_PROJECT_FILE_BYTES } from './storage.js';

// ───────────── Storage ─────────────

/** Results of compilations (PDF, log, SyncTeX index), one prefix per project then compilation. */
export const COMPILE_OUTPUT_BUCKET = 'compile-output';
/** Intermediate files (.aux, .bbl, .toc…) restored before the next compilation of a project. */
export const COMPILE_CACHE_BUCKET = 'compile-cache';

export const COMPILE_OUTPUT_FILES = {
  pdf: 'output.pdf',
  log: 'output.log',
  synctex: 'synctex.json.gz',
} as const;
export type CompileOutputFile = keyof typeof COMPILE_OUTPUT_FILES;

export function compileOutputPrefix(projectId: string, compilationId: string): string {
  return `${projectId}/${compilationId}/`;
}

export function compileOutputKey(
  projectId: string,
  compilationId: string,
  file: CompileOutputFile,
): string {
  return `${compileOutputPrefix(projectId, compilationId)}${COMPILE_OUTPUT_FILES[file]}`;
}

export function compileCacheKey(projectId: string): string {
  return `${projectId}/cache.tar`;
}

/**
 * Validity of the presigned GET URLs of the project files placed in a job (docs/spec.md,
 * "Réseau et pare-feu"): the worker holds no right on the projects bucket.
 */
export const COMPILE_SOURCE_URL_SECONDS = 300;

/** Validity of a signed link to a PDF on the files domain (docs/spec.md: 15 minutes). */
export const PDF_LINK_SECONDS = 15 * 60;

/** BullMQ priorities (1 runs first): Team and Business, then Standard, then Free. */
export const COMPILE_PRIORITY_RANK = { HIGH: 1, NORMAL: 2, LOW: 3 } as const;

/** Idle time after the last keystroke before an automatic compilation (paid plans). */
export const AUTO_COMPILE_DELAY_MS = 2000;

export const ENGINES = ['PDFLATEX', 'XELATEX', 'LUALATEX'] as const;
export type EngineValue = (typeof ENGINES)[number];

// ───────────── Job ─────────────

const id = z.string().min(1).max(64);

/** Data of a compilation job, written by the API and checked again by the worker. */
export const compileJobSchema = z.object({
  compilationId: id,
  projectId: id,
  engine: z.enum(ENGINES),
  mainFile: z.string().min(1).max(PATH_LIMITS.maxLength),
  /** Maximum duration of the plan of the project owner. */
  timeoutSeconds: z.number().int().positive().max(3600),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(PATH_LIMITS.maxLength),
        size: z.number().int().nonnegative().max(MAX_PROJECT_FILE_BYTES),
        /** Presigned GET URL of the object, valid COMPILE_SOURCE_URL_SECONDS. */
        url: z.url(),
      }),
    )
    .max(5000),
});
export type CompileJob = z.infer<typeof compileJobSchema>;

/**
 * How a compilation ended. `tex_errors` may still come with a PDF; the others (but `success`)
 * never do, except `output_too_large` which drops it.
 */
export const COMPILE_OUTCOMES = [
  'success',
  'tex_errors',
  'no_pdf',
  'timeout',
  'memory',
  'output_too_large',
  'main_missing',
  'sources_unavailable',
  'internal',
] as const;
export type CompileOutcome = (typeof COMPILE_OUTCOMES)[number];

export const compileIssueSchema = z.object({
  id: z.enum(COMPILE_ISSUE_IDS),
  severity: z.enum(['error', 'warning']),
  /** Project path of the file, or null when the message is not tied to a project file. */
  file: z.string().max(PATH_LIMITS.maxLength).nullable(),
  line: z.number().int().positive().nullable(),
  /** Values inserted in the translated message (command, file, label…), short strings. */
  args: z.record(z.string(), z.string().max(200)),
  /** First line of the original message, for the raw view. */
  raw: z.string().max(400),
});
export type CompileIssue = z.infer<typeof compileIssueSchema>;

/** Return value of a job, stored by the API on the `Compilation` row. */
export const compileResultSchema = z.object({
  outcome: z.enum(COMPILE_OUTCOMES),
  durationMs: z.number().int().nonnegative(),
  issues: z.array(compileIssueSchema).max(100),
  errorCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),
  pdfBytes: z.number().int().positive().nullable(),
  log: z.boolean(),
  synctex: z.boolean(),
  worker: z.string().max(100),
});
export type CompileResult = z.infer<typeof compileResultSchema>;

// ───────────── Requests and responses ─────────────

export const compileRequestSchema = z.object({
  /** Started by the editor after 2 s without typing (paid plans only). */
  auto: z.boolean().default(false),
});
export type CompileRequest = z.infer<typeof compileRequestSchema>;

const date = z.iso.datetime();

export const COMPILATION_STATUSES = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
  'CANCELED',
] as const;
export type CompilationStatusValue = (typeof COMPILATION_STATUSES)[number];

export const compilationSchema = z.object({
  id,
  status: z.enum(COMPILATION_STATUSES),
  engine: z.enum(ENGINES),
  outcome: z.enum(COMPILE_OUTCOMES).nullable(),
  queuedAt: date,
  startedAt: date.nullable(),
  finishedAt: date.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  /** Place in the queue (1 = next) while queued. */
  position: z.number().int().positive().nullable(),
  /** Maximum duration of the plan, in seconds. */
  maxSeconds: z.number().int().positive(),
  issues: z.array(compileIssueSchema),
  errorCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),
  /** Signed links on the files domain, renewed by asking again before `expiresAt`. */
  pdf: z
    .object({ url: z.url(), downloadUrl: z.url(), expiresAt: date, bytes: z.number().int() })
    .nullable(),
  log: z.boolean(),
  synctex: z.boolean(),
});
export type Compilation = z.infer<typeof compilationSchema>;

/** What the editor needs on opening: the last compilation and the last PDF produced. */
export const compileStateSchema = z.object({
  current: compilationSchema.nullable(),
  /** Last compilation with a PDF (may be `current`). */
  lastPdf: compilationSchema.nullable(),
  /** Owner and editor of a project that is not read-only (docs/spec.md, "Compilation"). */
  canCompile: z.boolean(),
  /** Automatic compilation allowed by the plan of the project owner. */
  autoCompile: z.boolean(),
  maxSeconds: z.number().int().positive(),
  maxPerHour: z.number().int().positive(),
});
export type CompileState = z.infer<typeof compileStateSchema>;

// ───────────── SyncTeX ─────────────

/**
 * Compact SyncTeX index built by the worker from `<job>.synctex.gz`. Coordinates are PDF points
 * from the top-left corner of the page. A box is [input, line, x, y (baseline), width, height,
 * depth]; inputs are project paths (system files are left out).
 */
export interface SynctexIndex {
  inputs: string[];
  /** Boxes of each page, page 1 first. */
  pages: [number, number, number, number, number, number, number][][];
}
