import { z } from 'zod';
import { PLAN_CODES } from './plans.js';
import { ALLOWED_PROJECT_EXTENSIONS, allowedExtensionOf, extensionOf } from './storage.js';

/** Days a project stays in the trash before it is erased (docs/spec.md, "Projets"). */
export const TRASH_RETENTION_DAYS = 30;

/** Error codes returned by the project, file and template endpoints in `{ code }`. */
export const PROJECT_ERROR_CODES = [
  'not_found',
  'forbidden',
  'read_only',
  'busy',
  'project_limit',
  'storage_limit',
  'invalid_path',
  'path_taken',
  'file_locked',
  'extension_not_allowed',
  'file_too_large',
  'type_mismatch',
  'invalid_encoding',
  'empty_file',
  'not_in_trash',
  'erase_blocked',
  'too_many_files',
  'archive_too_large',
  'archive_invalid',
  'archive_encrypted',
  'archive_unsafe',
  'archive_too_many_files',
  'archive_too_big_uncompressed',
  'archive_empty',
  'not_text',
  // Compilation (step 6).
  'compile_limit',
  'auto_compile_unavailable',
  'main_missing',
  'compile_unavailable',
  'no_output',
  // Project download (ZIP).
  'download_in_progress',
  'download_expired',
  // Read-only projects beyond the plan's limits (step 10).
  'not_read_only',
  'release_required',
  'invalid_release',
] as const;
export type ProjectErrorCode = (typeof PROJECT_ERROR_CODES)[number];

// ───────────── Paths ─────────────

/** Limits of a file path inside a project. */
export const PATH_LIMITS = { maxLength: 300, maxSegment: 120, maxDepth: 10 } as const;

// Control characters, and characters refused by common file systems or awkward for TeX.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_PATH_CHARS = /[\u0000-\u001f\u007f\\:*?"<>|#%~$]/;

/**
 * Normalizes a path typed by a user or found in an archive ("chapitres/intro.tex"): NFC, no
 * leading or trailing slash, no empty, "." or ".." segment, no forbidden character. Returns null
 * when the path is not acceptable. Folder paths use the same rules.
 */
export function normalizeProjectPath(input: string): string | null {
  const path = input.normalize('NFC').trim();
  if (!path || path.length > PATH_LIMITS.maxLength || path.startsWith('/')) return null;
  if (FORBIDDEN_PATH_CHARS.test(path)) return null;
  const segments = path.split('/');
  if (segments.length > PATH_LIMITS.maxDepth) return null;
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return null;
    if (segment.length > PATH_LIMITS.maxSegment || segment !== segment.trim()) return null;
  }
  return segments.join('/');
}

/** Normalized path of a file: also requires an allowed extension. */
export function normalizeFilePath(input: string): string | null {
  const path = normalizeProjectPath(input);
  return path && allowedExtensionOf(path) ? path : null;
}

/**
 * Whether a file or a folder can be created at `path` next to the existing file paths and kept
 * folders: no file or folder with the same path, and no existing file used as a folder
 * ("a.tex/b.tex"). Being inside a kept folder is fine.
 */
export function pathConflicts(
  existing: Iterable<string>,
  path: string,
  folders: Iterable<string> = [],
): boolean {
  for (const other of existing) {
    if (other === path || other.startsWith(`${path}/`) || path.startsWith(`${other}/`)) {
      return true;
    }
  }
  for (const folder of folders) {
    if (folder === path || folder.startsWith(`${path}/`)) return true;
  }
  return false;
}

/** Folder that holds `path` ("" for the root). */
export function parentFolder(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** Every folder of a project, sorted: the kept folders and the folders of the file paths. */
export function projectFolders(filePaths: Iterable<string>, kept: Iterable<string>): string[] {
  const folders = new Set<string>();
  const add = (folder: string) => {
    for (let end = folder.indexOf('/'); end >= 0; end = folder.indexOf('/', end + 1)) {
      folders.add(folder.slice(0, end));
    }
    if (folder) folders.add(folder);
  };
  for (const path of filePaths) add(parentFolder(path));
  for (const folder of kept) add(folder);
  return [...folders].sort();
}

/** Extension given to a new file typed without one ("test" → "test.tex"). */
export const DEFAULT_FILE_EXTENSION = '.tex';

/** Why a name typed for a file or a folder is refused, with what the message needs. */
export type NameProblem =
  | { code: 'name_empty' }
  | { code: 'name_slash' }
  | { code: 'name_dots' }
  | { code: 'name_char'; char: string }
  | { code: 'name_too_long'; max: number }
  | { code: 'path_too_long'; max: number }
  | { code: 'path_too_deep'; max: number }
  | { code: 'name_extension'; extension: string; extensions: readonly string[] }
  | { code: 'name_taken'; name: string };

export type NameCheck =
  { ok: true; name: string; path: string } | { ok: false; problem: NameProblem };

/**
 * Checks a name typed for a new or renamed file or folder in `folder` ("" for the root), with
 * the precise reason of a refusal. A file name without extension takes `defaultExtension`
 * (".tex" for a new file, the current one for a renamed file). `existing` holds the file paths
 * and kept folders of the project; `ignore` is the path being renamed (and what it holds).
 */
export function checkEntryName(
  input: string,
  kind: 'file' | 'folder',
  folder: string,
  existing: { files: readonly string[]; folders: readonly string[] },
  options: { ignore?: string; defaultExtension?: string } = {},
): NameCheck {
  let name = input.normalize('NFC').trim();
  if (!name) return { ok: false, problem: { code: 'name_empty' } };
  if (name.includes('/')) return { ok: false, problem: { code: 'name_slash' } };
  if (name === '.' || name === '..') return { ok: false, problem: { code: 'name_dots' } };
  const forbidden = FORBIDDEN_PATH_CHARS.exec(name);
  if (forbidden) return { ok: false, problem: { code: 'name_char', char: forbidden[0] } };
  if (kind === 'file') {
    if (!name.includes('.')) name += options.defaultExtension ?? DEFAULT_FILE_EXTENSION;
    if (!allowedExtensionOf(name)) {
      return {
        ok: false,
        problem: {
          code: 'name_extension',
          extension: extensionOf(name) ?? name.slice(name.lastIndexOf('.')),
          extensions: ALLOWED_PROJECT_EXTENSIONS,
        },
      };
    }
  }
  if (name.length > PATH_LIMITS.maxSegment) {
    return { ok: false, problem: { code: 'name_too_long', max: PATH_LIMITS.maxSegment } };
  }
  const path = folder ? `${folder}/${name}` : name;
  if (path.length > PATH_LIMITS.maxLength) {
    return { ok: false, problem: { code: 'path_too_long', max: PATH_LIMITS.maxLength } };
  }
  if (path.split('/').length > PATH_LIMITS.maxDepth) {
    return { ok: false, problem: { code: 'path_too_deep', max: PATH_LIMITS.maxDepth } };
  }
  const { ignore } = options;
  const kept = (other: string) => !ignore || (other !== ignore && !other.startsWith(`${ignore}/`));
  if (
    path !== ignore &&
    pathConflicts(existing.files.filter(kept), path, existing.folders.filter(kept))
  ) {
    return { ok: false, problem: { code: 'name_taken', name } };
  }
  return { ok: true, name, path };
}

/** Path of a file or folder moved into `folder` ("" for the root), keeping its name. */
export function movedPath(path: string, folder: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return folder ? `${folder}/${name}` : name;
}

// ───────────── Roles and rights ─────────────

export const PROJECT_ROLES = ['OWNER', 'EDITOR', 'SUPERVISOR', 'REVIEWER', 'VIEWER'] as const;
export type ProjectRoleValue = (typeof PROJECT_ROLES)[number];

/** What a role may do on a project (docs/spec.md, rights table). */
export interface ProjectRights {
  read: boolean;
  /** Comment, reply and propose a replacement: every role except the reader (Lecteur). */
  comment: boolean;
  /** Apply or refuse a replacement proposal: owner and editor. */
  applySuggestion: boolean;
  edit: boolean;
  /** Invite, change a role, remove an access, create and revoke public links. */
  share: boolean;
  /** Rename, move to the trash, restore, erase, duplicate. */
  manage: boolean;
}

export const projectRightsSchema = z.object({
  read: z.boolean(),
  comment: z.boolean(),
  applySuggestion: z.boolean(),
  edit: z.boolean(),
  share: z.boolean(),
  manage: z.boolean(),
});

export function projectRights(role: ProjectRoleValue): ProjectRights {
  const writer = role === 'OWNER' || role === 'EDITOR';
  return {
    read: true,
    comment: role !== 'VIEWER',
    applySuggestion: writer,
    edit: writer,
    share: role === 'OWNER',
    manage: role === 'OWNER',
  };
}

// ───────────── Requests ─────────────

const name = z.string().trim().min(1).max(120);
const id = z.string().min(1).max(64);

export const createProjectSchema = z.object({ name, templateId: id.optional() });
export type CreateProjectRequest = z.infer<typeof createProjectSchema>;

export const duplicateProjectSchema = z.object({ name });

export const updateProjectSchema = z
  .object({
    name: name.optional(),
    mainFilePath: z.string().max(PATH_LIMITS.maxLength).optional(),
    /** Compilation engine, chosen per project (docs/spec.md, "Compilation"). */
    engine: z.enum(['PDFLATEX', 'XELATEX', 'LUALATEX']).optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined || body.mainFilePath !== undefined || body.engine !== undefined,
  );
export type UpdateProjectRequest = z.infer<typeof updateProjectSchema>;

const path = z.string().max(PATH_LIMITS.maxLength * 2);

/** New empty text file. */
export const createFileSchema = z.object({ path });
/** Rename or move a file. */
export const moveFileSchema = z.object({ path });
/** Rename or move a folder and everything inside it. */
export const moveFolderSchema = z.object({ from: path, to: path });
export const deleteFolderSchema = z.object({ path });
/** New empty folder. */
export const createFolderSchema = z.object({ path });

export const projectNameQuerySchema = z.object({ name });
export const uploadQuerySchema = z.object({
  path,
  replace: z.enum(['true', 'false']).default('false'),
});

// ───────────── Responses ─────────────

const date = z.iso.datetime();

/** Usage of the signed-in user against the quotas of their effective plan. */
export const projectUsageSchema = z.object({
  planCode: z.enum(PLAN_CODES),
  /** Name of the plan in the `Plan` table. */
  planName: z.object({ fr: z.string(), en: z.string() }),
  projects: z.number().int().nonnegative(),
  maxProjects: z.number().int().nonnegative().nullable(),
  storageBytes: z.number().int().nonnegative(),
  maxStorageBytes: z.number().int().nonnegative(),
});
export type ProjectUsage = z.infer<typeof projectUsageSchema>;

export const projectSummarySchema = z.object({
  id,
  name: z.string(),
  role: z.enum(PROJECT_ROLES),
  ownerName: z.string(),
  lastActivityAt: date,
  createdAt: date,
  readOnly: z.boolean(),
  sizeBytes: z.number().int().nonnegative(),
  /** Trash only: when the project was deleted and when it will be erased. */
  deletedAt: date.nullable(),
  purgeAt: date.nullable(),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export const projectListSchema = z.object({
  projects: z.array(projectSummarySchema),
  usage: projectUsageSchema,
});
export type ProjectList = z.infer<typeof projectListSchema>;

export const projectFileSchema = z.object({
  id,
  path: z.string(),
  kind: z.enum(['TEXT', 'BINARY']),
  sizeBytes: z.number().int().nonnegative(),
  locked: z.boolean(),
  /** Validated submission that locks the file. */
  lockedBy: id.nullable(),
  updatedAt: date,
});
export type ProjectFileInfo = z.infer<typeof projectFileSchema>;

export const projectDetailSchema = projectSummarySchema.extend({
  mainFilePath: z.string(),
  engine: z.enum(['PDFLATEX', 'XELATEX', 'LUALATEX']),
  rights: projectRightsSchema,
  files: z.array(projectFileSchema),
  /** Every folder, empty or not, sorted. */
  folders: z.array(z.string()),
});
export type ProjectDetail = z.infer<typeof projectDetailSchema>;

/** Why a file of an imported archive was left out. */
export const SKIP_REASONS = [
  'extension_not_allowed',
  'file_too_large',
  'type_mismatch',
  'invalid_encoding',
  'invalid_path',
  'path_taken',
  'nested_archive',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export const skippedFileSchema = z.object({ path: z.string(), reason: z.enum(SKIP_REASONS) });
export type SkippedFile = z.infer<typeof skippedFileSchema>;

export const importResultSchema = z.object({
  project: projectSummarySchema,
  imported: z.number().int().nonnegative(),
  /** The first files left out (the report is capped); `skippedCount` counts them all. */
  skipped: z.array(skippedFileSchema),
  skippedCount: z.number().int().nonnegative(),
});
export type ImportResult = z.infer<typeof importResultSchema>;

/** Upload limits, from the API configuration and docs/spec.md. */
export const projectLimitsSchema = z.object({
  maxFileBytes: z.number().int().positive(),
  maxArchiveBytes: z.number().int().positive(),
  extensions: z.array(z.string()),
});
export type ProjectLimits = z.infer<typeof projectLimitsSchema>;

/**
 * A download of the whole project (ZIP), granted by `POST :id/archive`: the browser follows
 * `GET :id/archive?t=<token>` within five minutes. `tooLargeForImport` when the project is beyond a
 * limit of the ZIP import (warning shown before the download, never a refusal).
 */
export const archiveGrantSchema = z.object({
  token: z.string(),
  tooLargeForImport: z.boolean(),
});
export type ArchiveGrant = z.infer<typeof archiveGrantSchema>;
export const archiveQuerySchema = z.object({ t: z.string().min(1).max(128) });

export const templateSummarySchema = z.object({
  id,
  name: z.string(),
  description: z.string().nullable(),
  category: z.string(),
  scope: z.enum(['PUBLIC', 'ORGANIZATION']),
  /** Organization of an official template. */
  organizationName: z.string().nullable(),
});
export type TemplateSummary = z.infer<typeof templateSummarySchema>;

export const templateListSchema = z.array(templateSummarySchema);
