/** MinIO bucket holding public and organization template ZIPs (API access only). */
export const TEMPLATES_BUCKET = 'templates';

/** Private MinIO bucket holding project files, outside any web root (API access only). */
export const PROJECTS_BUCKET = 'projects';

/** Object key of a public template ZIP. */
export function publicTemplateKey(slug: string): string {
  return `public/${slug}.zip`;
}

/**
 * Prefix of every object of a project. Objects are keyed by a random id, never by the file path,
 * so renaming or moving a file never touches the storage; purging a project deletes the prefix.
 */
export function projectStoragePrefix(projectId: string): string {
  return `${projectId}/`;
}

/**
 * File extensions accepted in a project (docs/spec.md, "Projets"; `.jpeg` added on 2026-11-18 as
 * the same format as `.jpg`). Compared without case: `figure.PNG` is accepted.
 */
export const ALLOWED_PROJECT_EXTENSIONS = [
  '.tex',
  '.bib',
  '.sty',
  '.cls',
  '.txt',
  '.md',
  '.png',
  '.jpg',
  '.jpeg',
  '.pdf',
  '.eps',
] as const;
export type ProjectExtension = (typeof ALLOWED_PROJECT_EXTENSIONS)[number];

/** Extensions stored as UTF-8 text, editable in the editor. The others are binary files. */
export const TEXT_PROJECT_EXTENSIONS: readonly ProjectExtension[] = [
  '.tex',
  '.bib',
  '.sty',
  '.cls',
  '.txt',
  '.md',
];

/** Maximum size of one project file: 10 MB. */
export const MAX_PROJECT_FILE_BYTES = 10 * 1024 * 1024;

/** Lower-case extension of a file name or path (with the dot), or null when there is none. */
export function extensionOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : null;
}

/** The accepted extension of a path, or null when the extension is not allowed. */
export function allowedExtensionOf(path: string): ProjectExtension | null {
  const extension = extensionOf(path);
  return (ALLOWED_PROJECT_EXTENSIONS as readonly string[]).includes(extension ?? '')
    ? (extension as ProjectExtension)
    : null;
}

export function isTextExtension(extension: ProjectExtension): boolean {
  return TEXT_PROJECT_EXTENSIONS.includes(extension);
}

/** Private MinIO bucket holding receipt PDFs (API access only; receipts are sent by e-mail). */
export const RECEIPTS_BUCKET = 'receipts';

/** Object key of a receipt PDF, by its sequential number. */
export function receiptKey(number: number): string {
  return `${String(number).padStart(6, '0')}.pdf`;
}
