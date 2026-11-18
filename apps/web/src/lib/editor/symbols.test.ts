import { describe, expect, it } from 'vitest';
import { extractBibKeys, extractDefinitions, extractLabels, uniqueByName } from './symbols';

describe('project symbols', () => {
  it('extracts labels, not commented ones', () => {
    const text = '\\section{A}\\label{sec:a}\n% \\label{old}\n\\begin{equation}\\label{eq:1}';
    expect(extractLabels(text, 'main.tex').map((label) => label.name)).toEqual(['sec:a', 'eq:1']);
  });

  it('extracts BibTeX keys with their title', () => {
    const bib = [
      '@string{ujkz = "Université Joseph Ki-Zerbo"}',
      '@article{ouedraogo2021,',
      '  author = {Ouédraogo, A.},',
      '  title = {Hydrologie du {Nakanbé}},',
      '}',
      '@book{ kabore:2019 , title="Climat"}',
      '@comment{ignored,}',
    ].join('\n');
    expect(extractBibKeys(bib, 'refs.bib')).toEqual([
      { name: 'ouedraogo2021', path: 'refs.bib', detail: 'Hydrologie du Nakanbé' },
      { name: 'kabore:2019', path: 'refs.bib', detail: 'Climat' },
    ]);
  });

  it('extracts the commands and environments defined', () => {
    const text = [
      '\\newcommand{\\R}{\\mathbb{R}}',
      '\\newcommand\\norme[1]{\\lVert #1 \\rVert}',
      '\\DeclareMathOperator{\\argmax}{arg\\,max}',
      '\\def\\eps{\\varepsilon}',
      '\\newenvironment{encadre}{}{}',
    ].join('\n');
    const { commands, environments } = extractDefinitions(text, 'preambule.sty');
    expect(commands.map(({ name, args }) => [name, args])).toEqual([
      ['R', 0],
      ['norme', 1],
      ['argmax', 0],
      ['eps', 0],
    ]);
    expect(environments.map((environment) => environment.name)).toEqual(['encadre']);
  });

  it('keeps the first of duplicate names', () => {
    expect(
      uniqueByName([
        { name: 'a', n: 1 },
        { name: 'a', n: 2 },
        { name: 'b', n: 3 },
      ]),
    ).toEqual([
      { name: 'a', n: 1 },
      { name: 'b', n: 3 },
    ]);
  });
});
