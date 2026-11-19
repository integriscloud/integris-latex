import { describe, expect, it } from 'vitest';
import { findMatches, replaceAll, searchPattern } from './search';

const options = { caseSensitive: false, regexp: false, wholeWord: false };

describe('project search', () => {
  it('finds literal matches with their line, column and preview', () => {
    const pattern = searchPattern('bassin', options)!;
    const matches = findMatches('Le Bassin versant\nun autre bassin.', pattern);
    expect(matches.map(({ line, column }) => [line, column])).toEqual([
      [1, 4],
      [2, 10],
    ]);
    expect(matches[1]!.preview).toEqual({ before: 'un autre ', match: 'bassin', after: '.' });
  });

  it('escapes special characters unless regexp is on', () => {
    expect(
      findMatches('\\section{a} sectionX', searchPattern('\\section{', options)!),
    ).toHaveLength(1);
    const regexp = searchPattern('sec\\w+', { ...options, regexp: true })!;
    expect(findMatches('\\section{a} sectionX', regexp)).toHaveLength(2);
  });

  it('respects case and whole words, including accented letters', () => {
    const word = searchPattern('été', { ...options, wholeWord: true })!;
    expect(findMatches('été, étés et Été', word)).toHaveLength(2);
    const exact = searchPattern('été', { ...options, caseSensitive: true })!;
    expect(findMatches('été Été', exact)).toHaveLength(1);
  });

  it('finds whole words without a lookbehind, which Safari before 16.4 rejects', () => {
    const word = searchPattern('aa', { ...options, wholeWord: true })!;
    expect(word.source).not.toMatch(/\(\?<[=!]/);
    // A match preceded by a letter is skipped and the search goes on from the next character.
    expect(findMatches('baa aa aaa _aa 𝐀aa (aa)', word).map((match) => match.from)).toEqual([
      4, 21,
    ]);
    expect(replaceAll('baa aa aa', word, 'X', options)).toEqual({ text: 'baa X X', count: 2 });
    const regexp = searchPattern('a+', { ...options, regexp: true, wholeWord: true })!;
    expect(findMatches('ba aa', regexp).map((match) => match.from)).toEqual([3]);
  });

  it('refuses empty and invalid patterns', () => {
    expect(searchPattern('', options)).toBeNull();
    expect(searchPattern('(', { ...options, regexp: true })).toBeNull();
    expect(searchPattern('x*', { ...options, regexp: true })).toBeNull();
  });

  it('replaces literally, or with groups in regexp mode', () => {
    const literal = searchPattern('$x$', options)!;
    expect(replaceAll('a $x$ b $x$', literal, '$1', options)).toEqual({
      text: 'a $1 b $1',
      count: 2,
    });
    const regexpOptions = { ...options, regexp: true };
    const regexp = searchPattern('\\\\(textbf|emph)\\{', regexpOptions)!;
    expect(replaceAll('\\textbf{a} \\emph{b}', regexp, '\\textit{<$1>', regexpOptions)).toEqual({
      text: '\\textit{<textbf>a} \\textit{<emph>b}',
      count: 2,
    });
  });
});
