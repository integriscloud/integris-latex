import { describe, expect, it } from 'vitest';
import { blankComments, commentStart, parseOutline } from './outline';

describe('parseOutline', () => {
  it('lists the sections with their level and line', () => {
    const text = [
      '\\documentclass{report}',
      '\\begin{document}',
      '\\chapter{Introduction}',
      '\\section*{Contexte \\textbf{général}}',
      '% \\section{Commentée}',
      '\\subsection[court]{Un titre {imbriqué}}',
      'Du texte \\% pas un commentaire \\section{Inline}',
      '\\end{document}',
    ].join('\n');
    expect(
      parseOutline(text).map(({ command, level, title, line }) => [command, level, title, line]),
    ).toEqual([
      ['chapter', 1, 'Introduction', 3],
      ['section', 2, 'Contexte général', 4],
      ['subsection', 3, 'Un titre imbriqué', 6],
      ['section', 2, 'Inline', 7],
    ]);
  });

  it('ignores an unclosed title', () => {
    expect(parseOutline('\\section{Pas fermé\n\nla suite')).toEqual([]);
  });
});

describe('comments', () => {
  it('finds the comment start, skipping escaped percents', () => {
    expect(commentStart('50 \\% du total % note')).toBe(15);
    expect(commentStart('pas de commentaire')).toBe(-1);
  });

  it('blanks comments without moving offsets', () => {
    const text = 'a % b\nc';
    expect(blankComments(text)).toBe('a    \nc');
  });
});
