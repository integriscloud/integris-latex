import { foldService } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { commentStart, SECTION_LEVELS } from './outline';

const SECTION_LINE = new RegExp(`^\\s*\\\\(${SECTION_LEVELS.join('|')})\\*?\\s*[[{]`);
const BEGIN = /\\begin\s*\{([^{}]+)\}/;
const END_DOCUMENT = /^\s*\\end\s*\{document\}/;
const ENVIRONMENT = /\\(begin|end)\s*\{([^{}]+)\}/g;

const code = (text: string) => {
  const start = commentStart(text);
  return start < 0 ? text : text.slice(0, start);
};

/** A section folds up to the next section of the same or a higher level (or \end{document}). */
function sectionRange(state: EditorState, lineNumber: number, level: number) {
  const { doc } = state;
  const start = doc.line(lineNumber);
  let last = lineNumber;
  for (let number = lineNumber + 1; number <= doc.lines; number++) {
    const text = code(doc.line(number).text);
    const match = SECTION_LINE.exec(text);
    if ((match && SECTION_LEVELS.indexOf(match[1] as never) <= level) || END_DOCUMENT.test(text)) {
      break;
    }
    last = number;
  }
  // Trailing blank lines stay visible.
  while (last > lineNumber && !doc.line(last).text.trim()) last--;
  return last > lineNumber ? { from: start.to, to: doc.line(last).to } : null;
}

/** An environment folds from its \begin line to the line before the matching \end. */
function environmentRange(state: EditorState, lineNumber: number, name: string, column: number) {
  const { doc } = state;
  const start = doc.line(lineNumber);
  let depth = 0;
  for (let number = lineNumber; number <= Math.min(doc.lines, lineNumber + 5000); number++) {
    const text = code(doc.line(number).text);
    for (const match of text.matchAll(ENVIRONMENT)) {
      if (number === lineNumber && match.index < column) continue;
      if (match[2] !== name) continue;
      depth += match[1] === 'begin' ? 1 : -1;
      if (depth === 0) {
        // The \end line stays visible.
        return number > lineNumber + 1 ? { from: start.to, to: doc.line(number - 1).to } : null;
      }
    }
  }
  return null;
}

/** Folding of LaTeX sections and environments (gutter arrows and Ctrl+Shift+[). */
export const latexFolding = foldService.of((state, lineStart) => {
  const line = state.doc.lineAt(lineStart);
  const text = code(line.text);
  const section = SECTION_LINE.exec(text);
  if (section) return sectionRange(state, line.number, SECTION_LEVELS.indexOf(section[1] as never));
  const begin = BEGIN.exec(text);
  if (begin && begin[1] !== 'document') {
    return environmentRange(state, line.number, begin[1]!, begin.index);
  }
  return null;
});
