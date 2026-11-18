/** Sectioning commands, from the outermost to the innermost. */
export const SECTION_LEVELS = [
  'part',
  'chapter',
  'section',
  'subsection',
  'subsubsection',
  'paragraph',
  'subparagraph',
] as const;
export type SectionCommand = (typeof SECTION_LEVELS)[number];

export interface OutlineEntry {
  command: SectionCommand;
  /** 0 for \part … 6 for \subparagraph. */
  level: number;
  title: string;
  /** 1-based line of the command. */
  line: number;
  /** Offset of the backslash in the text. */
  from: number;
}

const SECTION = new RegExp(
  `\\\\(${SECTION_LEVELS.join('|')})\\*?\\s*(?:\\[[^\\]]*\\])?\\s*\\{`,
  'g',
);

/** Text up to the brace closing the group opened just before `start` (nested groups included). */
export function readGroup(text: string, start: number, limit = 500): string | null {
  let depth = 1;
  const end = Math.min(text.length, start + limit);
  for (let index = start; index < end; index++) {
    const char = text[index];
    if (char === '\\') {
      index++;
      continue;
    }
    if (char === '\n' && text[index + 1] === '\n') return null;
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return text.slice(start, index);
  }
  return null;
}

/** Offset of the `%` starting a comment on the line, or -1 (an escaped `\%` is text). */
export function commentStart(line: string): number {
  for (let index = 0; index < line.length; index++) {
    if (line[index] === '\\') index++;
    else if (line[index] === '%') return index;
  }
  return -1;
}

/** Text without comments, same length (comments become spaces), so offsets still match. */
export function blankComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const start = commentStart(line);
      return start < 0 ? line : line.slice(0, start) + ' '.repeat(line.length - start);
    })
    .join('\n');
}

/** Readable title: LaTeX markup is simplified, whitespace collapsed. */
function plainTitle(raw: string): string {
  return raw
    .replace(/\\(?:textbf|textit|emph|texttt|textsc|underline|mbox)\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z@]+\*?/g, '')
    .replace(/[{}]/g, '')
    .replace(/~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Sections of a LaTeX document, in order, ignoring commented-out lines. */
export function parseOutline(text: string): OutlineEntry[] {
  const source = blankComments(text);
  const entries: OutlineEntry[] = [];
  let line = 1;
  let lineFrom = 0;
  for (const match of source.matchAll(SECTION)) {
    const from = match.index;
    for (let index = lineFrom; index < from; index++) if (source[index] === '\n') line++;
    lineFrom = from;
    const title = readGroup(source, from + match[0].length);
    if (title === null) continue;
    const command = match[1] as SectionCommand;
    entries.push({
      command,
      level: SECTION_LEVELS.indexOf(command),
      title: plainTitle(title),
      line,
      from,
    });
  }
  return entries;
}
