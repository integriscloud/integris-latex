import { z } from 'zod';

/** An automatic version is taken this long after the first change following the previous one. */
export const AUTO_VERSION_DELAY_MS = 10 * 60 * 1000;

export const VERSION_LABEL_MAX = 100;

const date = z.iso.datetime();

export const versionSummarySchema = z.object({
  id: z.string(),
  kind: z.enum(['AUTO', 'NAMED', 'SUBMISSION']),
  label: z.string().nullable(),
  createdAt: date,
  authorName: z.string().nullable(),
  fileCount: z.number().int().nonnegative(),
  /** Saved just before restoring this version (and only this file when `path` is set). */
  restoreOf: z.object({ createdAt: date.nullable(), path: z.string().nullable() }).nullable(),
});
export type VersionSummary = z.infer<typeof versionSummarySchema>;

export const versionListSchema = z.object({
  /** Most recent first, within the history limit of the plan of the project owner. */
  versions: z.array(versionSummarySchema),
  /** History limit in days; null when unlimited. */
  historyDays: z.number().int().positive().nullable(),
  /** Older versions kept but hidden by the limit (they come back with a higher plan). */
  hiddenCount: z.number().int().nonnegative(),
  /** Whether the user may name versions and restore (owner, editor, project not read-only). */
  canRestore: z.boolean(),
});
export type VersionList = z.infer<typeof versionListSchema>;

export const versionFileSchema = z.object({
  path: z.string(),
  kind: z.enum(['TEXT', 'BINARY']),
  sizeBytes: z.number().int().nonnegative(),
  /** Compared with the project now. */
  change: z.enum(['same', 'modified', 'removed']),
});
export type VersionFile = z.infer<typeof versionFileSchema>;

export const versionDetailSchema = z.object({
  version: versionSummarySchema,
  files: z.array(versionFileSchema),
  /** Files of the project created since this version (removed by a whole restoration). */
  added: z.array(z.string()),
});
export type VersionDetail = z.infer<typeof versionDetailSchema>;

export const createVersionSchema = z.object({
  label: z.string().trim().min(1).max(VERSION_LABEL_MAX),
});

/** Restores the whole project, or only `path` when given. */
export const restoreVersionSchema = z.object({ path: z.string().min(1).max(400).optional() });

export const restoreResultSchema = z.object({
  /** Files whose content changed or that came back. */
  restored: z.number().int().nonnegative(),
  /** Files created since the version, removed. */
  removed: z.number().int().nonnegative(),
  /** Files left as they are: locked by a validated submission, or in the way of a folder. */
  kept: z.array(z.string()),
});
export type RestoreResult = z.infer<typeof restoreResultSchema>;
