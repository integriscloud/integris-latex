import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

// Public templates published by Integris (generic, French, pdfLaTeX, no university norms).
// Sources live in prisma/templates/<slug>/; the seed zips each folder and uploads it to MinIO.

export const TEMPLATES_DIR = fileURLToPath(new URL('../templates/', import.meta.url));

export interface PublicTemplate {
  slug: string;
  name: string;
  description: string;
  category: string;
}

export const PUBLIC_TEMPLATES: readonly PublicTemplate[] = [
  {
    slug: 'article',
    name: 'Article',
    description:
      'Article scientifique : résumé, sections, équations, tableau et bibliographie BibTeX.',
    category: 'article',
  },
  {
    slug: 'rapport',
    name: 'Rapport',
    description: 'Rapport de stage ou de projet : page de titre, table des matières et chapitres.',
    category: 'rapport',
  },
  {
    slug: 'memoire',
    name: 'Mémoire',
    description:
      'Mémoire de fin d’études générique : page de garde, remerciements, résumé, chapitres séparés et bibliographie.',
    category: 'memoire',
  },
  {
    slug: 'beamer',
    name: 'Présentation Beamer',
    description: 'Diaporama de soutenance ou d’exposé avec plan, colonnes et blocs.',
    category: 'beamer',
  },
  {
    slug: 'cv',
    name: 'CV',
    description: 'Curriculum vitæ simple et sobre sur une page.',
    category: 'cv',
  },
];

/** Relative POSIX paths of every file of a template folder, sorted. */
export function listTemplateFiles(slug: string): string[] {
  const root = join(TEMPLATES_DIR, slug);
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

// Fixed timestamp so the same sources always produce the same ZIP bytes.
const ZIP_MTIME = new Date('2026-01-01T00:00:00Z');

/** Deterministic ZIP of a template folder. */
export function zipTemplate(slug: string): Uint8Array {
  const root = join(TEMPLATES_DIR, slug);
  const entries: Record<string, [Uint8Array, { mtime: Date }]> = {};
  for (const path of listTemplateFiles(slug)) {
    entries[path] = [readFileSync(join(root, path)), { mtime: ZIP_MTIME }];
  }
  return zipSync(entries, { level: 9 });
}
