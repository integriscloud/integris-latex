import { HighlightStyle, StreamLanguage, type StreamParser } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import type { Extension } from '@codemirror/state';
import { tags } from '@lezer/highlight';

/** Kind of text file, from its extension: decides highlighting, completion and outline. */
export type TextKind = 'latex' | 'bibtex' | 'markdown' | 'plain';

export function textKindOf(path: string): TextKind {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (extension === 'tex' || extension === 'sty' || extension === 'cls') return 'latex';
  if (extension === 'bib') return 'bibtex';
  if (extension === 'md') return 'markdown';
  return 'plain';
}

/** Minimal BibTeX highlighting: entry types, keys, field names, comments. */
const bibtexParser: StreamParser<{ inEntry: boolean; afterType: boolean }> = {
  name: 'bibtex',
  startState: () => ({ inEntry: false, afterType: false }),
  token(stream, state) {
    if (stream.eatSpace()) return null;
    if (stream.match(/^@[a-zA-Z]+/)) {
      state.inEntry = true;
      state.afterType = true;
      return 'keyword';
    }
    if (!state.inEntry && stream.match(/^%.*/)) return 'comment';
    if (state.afterType && stream.match(/^[{(]\s*[^\s,{}()]+/)) {
      state.afterType = false;
      return 'atom';
    }
    if (stream.match(/^[a-zA-Z_-]+(?=\s*=)/)) return 'propertyName';
    if (stream.match(/^\\[a-zA-Z]+/)) return 'tag';
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '%' } },
};

export const latexLanguage = StreamLanguage.define(stex);
const bibtexLanguage = StreamLanguage.define(bibtexParser);

/** Language support of a file; Markdown is loaded only when a `.md` file is opened. */
export async function languageFor(kind: TextKind): Promise<Extension> {
  if (kind === 'latex') return latexLanguage;
  if (kind === 'bibtex') return bibtexLanguage;
  if (kind === 'markdown') return (await import('@codemirror/lang-markdown')).markdown();
  return [];
}

/** Syntax colours of the design system ("Coloration LaTeX" tokens). */
export const codeHighlight = HighlightStyle.define([
  { tag: [tags.tagName, tags.keyword, tags.heading], color: 'var(--code-commande)' },
  { tag: [tags.atom, tags.propertyName, tags.link, tags.url], color: 'var(--code-argument)' },
  { tag: [tags.special(tags.variableName), tags.number], color: 'var(--code-math)' },
  { tag: tags.comment, color: 'var(--code-commentaire)', fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.bracket, color: 'var(--texte-3)' },
]);
