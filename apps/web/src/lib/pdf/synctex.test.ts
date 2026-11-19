import type { SynctexIndex } from '@integris/shared';
import { describe, expect, it } from 'vitest';
import { forwardSearch, inverseSearch } from './synctex';

// Two pages; boxes are [input, line, x, baseline, width, height, depth].
const INDEX: SynctexIndex = {
  inputs: ['main.tex', 'chapitres/intro.tex'],
  pages: [
    [
      [0, 5, 133, 100, 340, 7, 2],
      [1, 3, 133, 120, 340, 7, 2],
      [1, 3, 133, 132, 200, 7, 2],
      [1, 3, 150, 132, 0, 0, 0],
    ],
    [
      [1, 9, 133, 100, 340, 7, 2],
      [1, 20, 140, 300, 100, 7, 2],
    ],
  ],
};

describe('forwardSearch', () => {
  it('covers the boxes of the line on its first page', () => {
    expect(forwardSearch(INDEX, 'chapitres/intro.tex', 3)).toEqual({
      page: 1,
      x: 133,
      y: 113,
      width: 340,
      height: 21,
    });
  });

  it('falls back to the nearest line before that produced output', () => {
    expect(forwardSearch(INDEX, 'chapitres/intro.tex', 15)).toMatchObject({ page: 2, y: 93 });
    expect(forwardSearch(INDEX, 'chapitres/intro.tex', 1)).toBeNull();
    expect(forwardSearch(INDEX, 'absent.tex', 1)).toBeNull();
  });
});

describe('inverseSearch', () => {
  it('finds the smallest box under the point, else the nearest one', () => {
    expect(inverseSearch(INDEX, 1, 200, 130)).toEqual({ path: 'chapitres/intro.tex', line: 3 });
    expect(inverseSearch(INDEX, 1, 200, 98)).toEqual({ path: 'main.tex', line: 5 });
    expect(inverseSearch(INDEX, 2, 150, 500)).toEqual({ path: 'chapitres/intro.tex', line: 20 });
    expect(inverseSearch(INDEX, 3, 0, 0)).toBeNull();
  });
});
