import { describe, expect, it } from 'vitest';
import { countDocumentWords, countLatexWords } from './word-count';

const project = (files: Record<string, string>) => (path: string) => files[path];

describe('countLatexWords', () => {
  it('counts the written text, headings and captions, not the commands', () => {
    const text = [
      '\\section{Introduction générale}\\label{sec:intro}',
      "L'étude du bassin versant~\\cite[p.~3]{dupont2020} montre une \\emph{baisse} des débits.",
      '\\begin{figure}[htbp]',
      '  \\centering\\includegraphics[width=0.8\\textwidth]{figures/carte.png}',
      '  \\caption{Carte du bassin}',
      '\\end{figure}',
      'Voir la figure~\\ref{fig:carte}, page~\\pageref{fig:carte}.\\\\[2pt]',
      'Fin.',
    ].join('\n');
    // Introduction générale (2) + L'étude … débits (9) + Carte du bassin (3)
    // + Voir la figure page (4) + Fin (1).
    expect(countLatexWords(text).words).toBe(19);
  });

  it('leaves formulas out and counts them', () => {
    const text = [
      'Le débit $Q = 2,5$ vaut \\(q\\) ou $$x^2$$ et \\[ y = 3 \\] selon',
      '\\begin{equation} E = mc^2 \\end{equation}',
      '\\begin{align*} a &= b \\\\ c &= d \\end{align*}',
      'Prix : 5 \\$ et 10 \\% seulement.',
    ].join('\n');
    const counted = countLatexWords(text);
    expect(counted.formulas).toBe(6);
    // Le débit vaut ou et selon (6) + Prix 5 et 10 seulement (5).
    expect(counted.words).toBe(11);
  });

  it('keeps accented letters written with commands inside their word', () => {
    expect(countLatexWords("Th{\\'e}se et m\\'emoire, \\^{a}ge").words).toBe(4);
  });

  it('skips code, column specifications and settings', () => {
    const text = [
      '\\begin{tabular}{|l|c|}',
      'Station & Débit \\\\',
      '\\multicolumn{2}{c}{Total annuel} \\\\',
      '\\end{tabular}',
      '\\begin{verbatim} code ignoré ici \\end{verbatim}',
      '\\verb|aussi ignoré| \\url{https://exemple.org} \\href{https://x.org}{le site}',
      '\\vspace{2cm}\\setlength{\\parindent}{0pt}',
    ].join('\n');
    // Station Débit Total annuel le site.
    expect(countLatexWords(text).words).toBe(6);
  });

  it('collects the files included', () => {
    expect(
      countLatexWords('\\input{chap1}\n\\include{parties/chap2.tex}\n\\input chap3').includes,
    ).toEqual(['chap1', 'parties/chap2.tex', 'chap3']);
  });
});

describe('countDocumentWords', () => {
  it('reads only the body of the main file and follows the included files once', () => {
    const read = project({
      'these.tex': [
        '\\documentclass{report}',
        '\\title{Titre ignoré}',
        '\\begin{document}',
        'Un deux trois. % commentaire ignoré',
        '\\input{chapitres/ch1}',
        '\\include{chapitres/ch2.tex}',
        '\\input{chapitres/ch1}',
        '\\input{absent}',
        '\\end{document}',
        'Après la fin.',
      ].join('\n'),
      'chapitres/ch1.tex': 'Quatre cinq.\n\\input{chapitres/ch2}',
      'chapitres/ch2.tex': 'Six $x$.\n\\input{these}',
    });
    expect(countDocumentWords('these.tex', read)).toEqual({
      words: 6,
      formulas: 1,
      files: ['these.tex', 'chapitres/ch1.tex', 'chapitres/ch2.tex'],
      missing: ['absent'],
    });
  });

  it('looks for included files next to the main file first, then at the root', () => {
    const read = project({
      'memoire/main.tex': '\\begin{document}\\input{intro}\\input{annexe}\\end{document}',
      'memoire/intro.tex': 'Mot un.',
      'annexe.tex': 'Mot deux trois.',
    });
    expect(countDocumentWords('memoire/main.tex', read)?.words).toBe(5);
  });

  it('counts a main file without document environment as a whole', () => {
    expect(
      countDocumentWords('notes.tex', project({ 'notes.tex': 'Trois petits mots' }))?.words,
    ).toBe(3);
  });

  it('is null when the main file is missing', () => {
    expect(countDocumentWords('main.tex', project({}))).toBeNull();
  });
});
