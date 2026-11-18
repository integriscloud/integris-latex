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
