import { describe, expect, it } from 'vitest';
import { buildFileTree, fileIconKind } from './build-tree';

const file = (path: string) => ({ id: path, path, size: '1 Ko' });

describe('buildFileTree', () => {
  it('nests folders and puts them first', () => {
    const tree = buildFileTree([
      file('main.tex'),
      file('chapitres/b.tex'),
      file('chapitres/a.tex'),
      file('chapitres/annexes/x.tex'),
      file('alpha.bib'),
    ]);
    expect(tree.map((entry) => entry.path)).toEqual(['chapitres', 'alpha.bib', 'main.tex']);
    const chapters = tree[0]!;
    expect(chapters.type === 'folder' && chapters.children.map((entry) => entry.path)).toEqual([
      'chapitres/annexes',
      'chapitres/a.tex',
      'chapitres/b.tex',
    ]);
  });

  it('shows empty folders', () => {
    const tree = buildFileTree([file('main.tex'), file('a/x.tex')], ['a', 'a/vide', 'annexes']);
    expect(tree.map((entry) => entry.path)).toEqual(['a', 'annexes', 'main.tex']);
    const a = tree[0]!;
    expect(a.type === 'folder' && a.children.map((entry) => entry.path)).toEqual([
      'a/vide',
      'a/x.tex',
    ]);
  });

  it('gives each file type its icon', () => {
    expect(fileIconKind('a/fig.JPEG')).toBe('image');
    expect(fileIconKind('refs.bib')).toBe('bibliography');
    expect(fileIconKind('x.cls')).toBe('style');
    expect(fileIconKind('carte.pdf')).toBe('pdf');
    expect(fileIconKind('notes.md')).toBe('text');
  });
});
