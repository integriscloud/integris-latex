/** MinIO bucket holding public and organization template ZIPs (API access only). */
export const TEMPLATES_BUCKET = 'templates';

/** Object key of a public template ZIP. */
export function publicTemplateKey(slug: string): string {
  return `public/${slug}.zip`;
}

/** File extensions accepted in a project (docs/spec.md, "Projets"). */
export const ALLOWED_PROJECT_EXTENSIONS = [
  '.tex',
  '.bib',
  '.sty',
  '.cls',
  '.txt',
  '.md',
  '.png',
  '.jpg',
  '.pdf',
  '.eps',
] as const;

/** Maximum size of one project file: 10 MB. */
export const MAX_PROJECT_FILE_BYTES = 10 * 1024 * 1024;
