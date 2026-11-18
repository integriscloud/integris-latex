import { statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { ALLOWED_PROJECT_EXTENSIONS, MAX_PROJECT_FILE_BYTES } from '@integris/shared';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { listTemplateFiles, PUBLIC_TEMPLATES, TEMPLATES_DIR, zipTemplate } from './templates.js';

describe('public templates', () => {
  it('ships the five generic templates', () => {
    expect(PUBLIC_TEMPLATES.map((template) => template.slug)).toEqual([
      'article',
      'rapport',
      'memoire',
      'beamer',
      'cv',
    ]);
  });

  describe.each(PUBLIC_TEMPLATES)('$slug', ({ slug }) => {
    const files = listTemplateFiles(slug);

    it('has a main.tex', () => {
      expect(files).toContain('main.tex');
    });

    it('only contains allowed file types under the size limit', () => {
      for (const path of files) {
        expect(ALLOWED_PROJECT_EXTENSIONS).toContain(extname(path));
        expect(statSync(join(TEMPLATES_DIR, slug, path)).size).toBeLessThanOrEqual(
          MAX_PROJECT_FILE_BYTES,
        );
      }
    });

    it('zips deterministically with every file', () => {
      const zip = zipTemplate(slug);
      expect(zipTemplate(slug)).toEqual(zip);
      expect(Object.keys(unzipSync(zip)).sort()).toEqual(files);
    });
  });
});
