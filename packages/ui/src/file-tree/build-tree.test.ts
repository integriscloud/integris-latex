import { describe, expect, it } from 'vitest';
import { buildFileTree, fileTypeLabel } from './build-tree';

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

  it('labels file types like the mockup', () => {
    expect(fileTypeLabel('a/fig.JPEG')).toBe('IMG');
    expect(fileTypeLabel('refs.bib')).toBe('BIB');
    expect(fileTypeLabel('x.cls')).toBe('STY');
  });
});
