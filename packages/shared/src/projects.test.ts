import { describe, expect, it } from 'vitest';
import {
  normalizeFilePath,
  normalizeProjectPath,
  pathConflicts,
  projectRights,
} from './projects.js';
import { allowedExtensionOf, extensionOf } from './storage.js';

describe('normalizeProjectPath', () => {
  it('keeps clean relative paths', () => {
    expect(normalizeProjectPath('chapitres/intro.tex')).toBe('chapitres/intro.tex');
    expect(normalizeProjectPath('  figures/bassin versant.png ')).toBe(
      'figures/bassin versant.png',
    );
  });

  it('normalizes to NFC', () => {
    expect(normalizeProjectPath('re\u0301sume\u0301.tex')).toBe('r\u00e9sum\u00e9.tex');
  });

  it.each([
    '',
    '/etc/passwd',
    '../main.tex',
    'a/../../b.tex',
    'a/./b.tex',
    'a//b.tex',
    'a/',
    'C:\\x.tex',
    'a\\b.tex',
    'a\u0000.tex',
    'cours%1.tex',
    'a /b.tex',
    `${'a'.repeat(121)}.tex`,
    `${'d/'.repeat(10)}x.tex`,
  ])('refuses %j', (path) => {
    expect(normalizeProjectPath(path)).toBeNull();
  });
});

describe('normalizeFilePath', () => {
  it('requires an allowed extension, without case', () => {
    expect(normalizeFilePath('figures/A.PNG')).toBe('figures/A.PNG');
    expect(normalizeFilePath('photo.jpeg')).toBe('photo.jpeg');
    expect(normalizeFilePath('script.sh')).toBeNull();
    expect(normalizeFilePath('latexmkrc')).toBeNull();
    expect(normalizeFilePath('.tex')).toBeNull();
  });
});

describe('extensions', () => {
  it('reads the last extension of the file name only', () => {
    expect(extensionOf('a.b/c')).toBeNull();
    expect(extensionOf('archive.tar.gz')).toBe('.gz');
    expect(allowedExtensionOf('x.tex.zip')).toBeNull();
    expect(allowedExtensionOf('Main.TeX')).toBe('.tex');
  });
});

describe('pathConflicts', () => {
  const existing = ['main.tex', 'chapitres/intro.tex'];

  it('detects same path, file used as a folder and folder of the same name', () => {
    expect(pathConflicts(existing, 'main.tex')).toBe(true);
    expect(pathConflicts(existing, 'main.tex/x.tex')).toBe(true);
    expect(pathConflicts(existing, 'chapitres')).toBe(true);
    expect(pathConflicts(existing, 'chapitres/conclusion.tex')).toBe(false);
    expect(pathConflicts(existing, 'chapitres2/intro.tex')).toBe(false);
  });
});

describe('projectRights', () => {
  it('follows the rights table of docs/spec.md', () => {
    expect(projectRights('OWNER')).toEqual({ read: true, edit: true, manage: true });
    expect(projectRights('EDITOR')).toEqual({ read: true, edit: true, manage: false });
    for (const role of ['SUPERVISOR', 'REVIEWER', 'VIEWER'] as const) {
      expect(projectRights(role)).toEqual({ read: true, edit: false, manage: false });
    }
  });
});
