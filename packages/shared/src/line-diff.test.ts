import { describe, expect, it } from 'vitest';
import { DIFF_MAX_EDITS, diffTexts, splitLines, wordDiff } from './line-diff.js';

/** Applies the hunks' lines back: the older and newer texts must come out again. */
function sides(before: string, after: string) {
  const diff = diffTexts(before, after, 1_000_000);
  const lines = diff.hunks.flatMap((hunk) => hunk.lines);
  return {
    diff,
    older: lines.filter((line) => line.type !== 'added').map((line) => line.text),
    newer: lines.filter((line) => line.type !== 'removed').map((line) => line.text),
  };
}

describe('line diff', () => {
  it('splits lines whatever the line breaks', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\r\nb\nc\rd\n')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('finds no change between equal texts', () => {
    expect(diffTexts('a\nb\n', 'a\nb\n')).toEqual({
      hunks: [],
      added: 0,
      removed: 0,
      tooLarge: false,
    });
  });

  it('shows changed lines with their numbers and context', () => {
    const before = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].join('\n');
    const after = ['1', '2', '3', '4', 'cinq', '6', '7', '8', '9', '10', '11'].join('\n');
    const diff = diffTexts(before, after, 1);
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(1);
    expect(diff.hunks).toHaveLength(2);
    expect(diff.hunks[0]!.lines).toEqual([
      { type: 'same', text: '4', from: 4, to: 4 },
      { type: 'removed', text: '5', from: 5, to: null },
      { type: 'added', text: 'cinq', from: null, to: 5 },
      { type: 'same', text: '6', from: 6, to: 6 },
    ]);
    expect(diff.hunks[1]!.lines.at(-1)).toEqual({ type: 'added', text: '11', from: null, to: 11 });
  });

  it('rebuilds both texts from the edit script (random texts)', () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let round = 0; round < 200; round++) {
      const make = () =>
        Array.from({ length: Math.floor(random() * 30) }, () => 'abcde'[Math.floor(random() * 5)]!);
      const a = make();
      const b = make();
      const { older, newer, diff } = sides(a.join('\n'), b.join('\n'));
      if (diff.hunks.length) {
        expect(older).toEqual(a);
        expect(newer).toEqual(b);
      } else {
        expect(a).toEqual(b);
      }
      // Minimal: never more than replacing everything.
      expect(diff.added + diff.removed).toBeLessThanOrEqual(a.length + b.length);
    }
  });

  it('gives up on very large changes', () => {
    const many = (prefix: string) =>
      Array.from({ length: DIFF_MAX_EDITS }, (_, index) => `${prefix}${index}`).join('\n');
    expect(diffTexts(many('a'), many('b')).tooLarge).toBe(true);
  });

  it('marks the words changed inside a changed line', () => {
    const diff = diffTexts(
      'Titre\nLes débits baissent de 38 % en été.\nFin\n',
      'Titre\nLes débits baissent de 42 % en saison sèche.\nFin\n',
    );
    const [removed, added] = diff.hunks[0]!.lines.filter((line) => line.type !== 'same');
    expect(removed!.segments).toEqual([
      { text: 'Les débits baissent de ', changed: false },
      { text: '38', changed: true },
      { text: ' % en ', changed: false },
      { text: 'été', changed: true },
      { text: '.', changed: false },
    ]);
    expect(added!.segments!.filter((part) => part.changed).map((part) => part.text)).toEqual([
      '42',
      'saison sèche',
    ]);
    // The segments always give the line back.
    expect(added!.segments!.map((part) => part.text).join('')).toBe(added!.text);
  });

  it('keeps LaTeX commands whole and leaves unrelated lines unmarked', () => {
    const marked = wordDiff('\\section{Introduction}', '\\subsection{Introduction}')!;
    expect(marked.older.find((part) => part.changed)!.text).toBe('\\section');
    expect(marked.newer.find((part) => part.changed)!.text).toBe('\\subsection');
    expect(wordDiff('Une phrase entière', 'Rien de commun ici')).toBeNull();
    const diff = diffTexts('a\nUne phrase entière\n', 'a\nRien de commun ici\n');
    expect(diff.hunks[0]!.lines.some((line) => line.segments)).toBe(false);
  });
});
