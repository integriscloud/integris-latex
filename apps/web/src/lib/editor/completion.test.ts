import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { describe, expect, it, vi } from 'vitest';
import { latexCompletion, type ProjectSymbols } from './completion';
import { extractBibKeys, extractLabels } from './symbols';

const labels = {
  inFile: (path: string) => `in ${path}`,
  command: 'command',
  environment: 'environment',
};

// Files of the "Mémoire" template: a .bib at the root, labels in a sub-folder.
const BIB =
  '@book{knuth1984,\n  title = {The {\\TeX}book},\n}\n@book{lamport1994,\n  title = {LaTeX},\n}\n';
const CHAPTER = '\\chapter{Revue}\\label{chap:revue}\n';

function setup(ready: boolean) {
  const symbols: ProjectSymbols = { labels: [], citations: [], commands: [], environments: [] };
  const index = {
    ready: () => ready,
    load: vi.fn(async () => {
      symbols.citations = extractBibKeys(BIB, 'biblio/references.bib');
      symbols.labels = extractLabels(CHAPTER, 'chapitres/chapitre1.tex');
      ready = true;
    }),
  };
  const source = latexCompletion(() => symbols, labels, index);
  const complete = async (text: string) => {
    const state = EditorState.create({ doc: `${text}}` });
    const result = await source(new CompletionContext(state, text.length, false));
    return result as CompletionResult | null;
  };
  return { complete, index };
}

const names = (result: CompletionResult | null) => result?.options.map((option) => option.label);

describe('latexCompletion', () => {
  it.each([
    '\\cite{',
    '\\citep{',
    '\\citet{',
    '\\autocite{',
    '\\autocite[p.~3][]{',
    '\\parencite*{',
  ])('offers the bibliography keys right after %s, once the files are read', async (text) => {
    const { complete, index } = setup(false);
    expect(names(await complete(`Voir ${text}`))).toEqual(['knuth1984', 'lamport1994']);
    expect(index.load).toHaveBeenCalledOnce();
  });

  it('completes the key being typed in a list', async () => {
    const { complete } = setup(false);
    const result = await complete('\\cite{knuth1984, lam');
    expect(result?.from).toBe('\\cite{knuth1984, '.length);
  });

  it.each(['\\ref{', '\\eqref{', '\\cref{', '\\autoref{'])(
    'offers the labels after %s',
    async (text) => {
      const { complete } = setup(false);
      expect(names(await complete(text))).toEqual(['chap:revue']);
    },
  );

  it('does not read the files again once they are read', async () => {
    const { complete, index } = setup(true);
    await complete('\\cite{');
    expect(index.load).not.toHaveBeenCalled();
  });

  it('offers environments after \\begin{ and nothing in other arguments', async () => {
    const { complete } = setup(true);
    expect(names(await complete('\\begin{item'))).toContain('itemize');
    expect(await complete('\\section{')).toBeNull();
  });
});
