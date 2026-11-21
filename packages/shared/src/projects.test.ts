import { describe, expect, it } from 'vitest';
import {
  checkEntryName,
  movedPath,
  normalizeFilePath,
  normalizeProjectPath,
  parentFolder,
  pathConflicts,
  projectFolders,
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

describe('pathConflicts with kept folders', () => {
  const files = ['main.tex', 'chapitres/intro.tex'];
  const folders = ['annexes/tableaux', 'vide'];

  it('refuses a file or a folder named like a kept folder or one of its parents', () => {
    expect(pathConflicts(files, 'vide', folders)).toBe(true);
    expect(pathConflicts(files, 'annexes', folders)).toBe(true);
    expect(pathConflicts(files, 'annexes/tableaux', folders)).toBe(true);
  });

  it('accepts a file or a folder inside a kept folder', () => {
    expect(pathConflicts(files, 'vide/a.tex', folders)).toBe(false);
    expect(pathConflicts(files, 'annexes/tableaux/b', folders)).toBe(false);
    expect(pathConflicts(files, 'annexes/autre.tex', folders)).toBe(false);
  });

  it('refuses a folder named like a file or a folder holding files', () => {
    expect(pathConflicts(files, 'main.tex', folders)).toBe(true);
    expect(pathConflicts(files, 'chapitres', folders)).toBe(true);
  });
});

describe('folders', () => {
  it('lists the kept folders and the folders of the files, parents included', () => {
    expect(projectFolders(['main.tex', 'a/b/c.tex', 'a/d.tex'], ['x/y', 'a'])).toEqual([
      'a',
      'a/b',
      'x',
      'x/y',
    ]);
  });

  it('gives the parent folder and the path after a move', () => {
    expect(parentFolder('a/b/c.tex')).toBe('a/b');
    expect(parentFolder('main.tex')).toBe('');
    expect(movedPath('a/b/c.tex', '')).toBe('c.tex');
    expect(movedPath('c.tex', 'x/y')).toBe('x/y/c.tex');
    expect(movedPath('a/b', 'x')).toBe('x/b');
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
  it('follows the rights table of docs/spec.md for the five roles', () => {
    // Read, comment and propose, apply a proposal, edit, share and delete.
    const table = {
      OWNER: [true, true, true, true, true],
      EDITOR: [true, true, true, true, false],
      SUPERVISOR: [true, true, false, false, false],
      REVIEWER: [true, true, false, false, false],
      VIEWER: [true, false, false, false, false],
    } as const;
    for (const [role, [read, comment, apply, edit, share]] of Object.entries(table)) {
      expect(projectRights(role as keyof typeof table)).toEqual({
        read,
        comment,
        applySuggestion: apply,
        edit,
        share,
        manage: share,
        // ZIP download: owner and editors (step 4 bis).
        download: edit,
      });
    }
  });

  it('keeps an exam paper with its owner: no sharing, ZIP for the owner only', () => {
    expect(projectRights('OWNER', 'ASSIGNMENT')).toMatchObject({
      share: false,
      manage: true,
      download: true,
      edit: true,
    });
    expect(projectRights('EDITOR', 'ASSIGNMENT')).toMatchObject({
      share: false,
      download: false,
      edit: true,
      comment: true,
    });
  });
});

describe('checkEntryName', () => {
  const existing = {
    files: ['main.tex', 'chapitres/intro.tex', 'figures/carte.png'],
    folders: ['annexes'],
  };

  it('adds .tex to a file name without extension and builds the path in the folder', () => {
    expect(checkEntryName(' test ', 'file', 'chapitres', existing)).toEqual({
      ok: true,
      name: 'test.tex',
      path: 'chapitres/test.tex',
    });
    expect(checkEntryName('refs.bib', 'file', '', existing)).toMatchObject({ path: 'refs.bib' });
    expect(
      checkEntryName('annexe', 'file', '', existing, { defaultExtension: '.md' }),
    ).toMatchObject({ name: 'annexe.md' });
    expect(checkEntryName('donnees', 'folder', 'annexes', existing)).toMatchObject({
      path: 'annexes/donnees',
    });
  });

  it('gives the precise reason of a refusal', () => {
    const problem = (name: string, kind: 'file' | 'folder' = 'file', folder = '') => {
      const check = checkEntryName(name, kind, folder, existing);
      return check.ok ? null : check.problem;
    };
    expect(problem('  ')).toEqual({ code: 'name_empty' });
    expect(problem('a/b.tex')).toEqual({ code: 'name_slash' });
    expect(problem('..', 'folder')).toEqual({ code: 'name_dots' });
    expect(problem('cours%1.tex')).toEqual({ code: 'name_char', char: '%' });
    expect(problem('notes.docx')).toMatchObject({
      code: 'name_extension',
      extension: '.docx',
      extensions: expect.arrayContaining(['.tex', '.bib', '.png']),
    });
    expect(problem('intro', 'file', 'chapitres')).toEqual({
      code: 'name_taken',
      name: 'intro.tex',
    });
    expect(problem('annexes', 'folder')).toEqual({ code: 'name_taken', name: 'annexes' });
    expect(problem('figures', 'folder')).toEqual({ code: 'name_taken', name: 'figures' });
    expect(problem(`${'a'.repeat(121)}`, 'folder')).toEqual({ code: 'name_too_long', max: 120 });
    const deep = Array.from({ length: 3 }, () => 'b'.repeat(100)).join('/');
    expect(problem('c'.repeat(10), 'folder', deep)).toEqual({ code: 'path_too_long', max: 300 });
    expect(problem('x', 'folder', 'a/b/c/d/e/f/g/h/i/j')).toEqual({
      code: 'path_too_deep',
      max: 10,
    });
  });

  it('ignores the entry being renamed', () => {
    expect(
      checkEntryName('intro', 'file', 'chapitres', existing, {
        ignore: 'chapitres/intro.tex',
      }),
    ).toMatchObject({ ok: true, path: 'chapitres/intro.tex' });
    expect(
      checkEntryName('chapitres', 'folder', '', existing, { ignore: 'chapitres' }),
    ).toMatchObject({ ok: true });
  });
});
