import { blankComments } from './outline';

/** Words of a document, as shown in the editor menu. */
export interface WordCount {
  /** Words of the written text, headings and captions. */
  words: number;
  /** Formulas left out of the count (inline and displayed). */
  formulas: number;
  /** Files read: the main file and the files it includes, in reading order. */
  files: string[];
  /** Files named by `\input` or `\include` that are not in the project. */
  missing: string[];
}

// Environments whose content is mathematics: one formula each, no words.
const MATH_ENVIRONMENTS = new Set(
  [
    'equation',
    'align',
    'gather',
    'multline',
    'flalign',
    'alignat',
    'eqnarray',
    'math',
    'displaymath',
    'dmath',
  ].flatMap((name) => [name, `${name}*`]),
);

// Environments whose content is not prose (code, drawings, comments).
const SKIPPED_ENVIRONMENTS = new Set([
  'verbatim',
  'verbatim*',
  'Verbatim',
  'lstlisting',
  'minted',
  'comment',
  'tikzpicture',
  'filecontents',
  'filecontents*',
]);

// Commands whose arguments are names, keys, paths or settings, never text: how many brace
// groups each one takes (optional `[…]` groups are always skipped).
const DROPPED: Record<string, number> = {
  label: 1,
  ref: 1,
  eqref: 1,
  pageref: 1,
  autoref: 1,
  nameref: 1,
  cref: 1,
  Cref: 1,
  cite: 1,
  citep: 1,
  citet: 1,
  citeauthor: 1,
  citeyear: 1,
  parencite: 1,
  textcite: 1,
  autocite: 1,
  footcite: 1,
  nocite: 1,
  bibitem: 1,
  usepackage: 1,
  RequirePackage: 1,
  documentclass: 1,
  includegraphics: 1,
  includepdf: 1,
  graphicspath: 1,
  bibliography: 1,
  bibliographystyle: 1,
  addbibresource: 1,
  printbibliography: 0,
  includeonly: 1,
  url: 1,
  href: 1,
  hspace: 1,
  vspace: 1,
  setlength: 2,
  addtolength: 2,
  setcounter: 2,
  addtocounter: 2,
  newcommand: 2,
  renewcommand: 2,
  providecommand: 2,
  DeclareMathOperator: 2,
  newenvironment: 3,
  renewenvironment: 3,
  newtheorem: 2,
  definecolor: 3,
  color: 1,
  textcolor: 1,
  colorbox: 1,
  pagestyle: 1,
  thispagestyle: 1,
  pagenumbering: 1,
  hypersetup: 1,
  geometry: 1,
  addcontentsline: 2,
  multicolumn: 2,
  multirow: 2,
  input: 1,
  include: 1,
  begin: 1,
  end: 1,
};

// Brace groups after the name of an environment that are settings (column specs, widths).
const ENVIRONMENT_SETTINGS: Record<string, number> = {
  tabular: 1,
  'tabular*': 2,
  array: 1,
  longtable: 1,
  tabularx: 2,
  tabulary: 2,
  minipage: 1,
  multicols: 1,
  wrapfigure: 2,
};

const ACCENTS = new Set(["'", '`', '^', '"', '~', '=', '.']);
const COMMAND_NAME = /[A-Za-z@]+\*?/y;
const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

/** Index just after the group opened by `open` at `start` (nested groups included). */
function closeOf(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (char === '\\') {
      index++;
      continue;
    }
    if (char === open) depth++;
    else if (char === close && --depth === 0) return index + 1;
  }
  return text.length;
}

const skipSpaces = (text: string, index: number) => {
  while (index < text.length && /\s/.test(text[index]!)) index++;
  return index;
};

/** Skips the optional `[…]` groups found at `index` (spaces allowed before them). */
function skipOptions(text: string, index: number): number {
  for (;;) {
    const next = skipSpaces(text, index);
    if (text[next] !== '[') return index;
    index = closeOf(text, next, '[', ']');
  }
}

/** Reads one argument at `index`: a brace group, or a single token. */
function readArgument(text: string, index: number): { value: string; end: number } {
  const start = skipSpaces(text, index);
  if (text[start] === '{') {
    const end = closeOf(text, start, '{', '}');
    return { value: text.slice(start + 1, end - 1), end };
  }
  const match = /^\S+/.exec(text.slice(start));
  const value = match ? match[0] : '';
  return { value, end: start + value.length };
}

/**
 * Removes formulas (counted), and code or drawings (not counted). The text has no comments.
 */
function removeMath(text: string): { text: string; formulas: number } {
  let out = '';
  let formulas = 0;
  let index = 0;
  const skipTo = (end: string, from: number) => {
    const found = text.indexOf(end, from);
    return found < 0 ? text.length : found + end.length;
  };
  while (index < text.length) {
    const char = text[index]!;
    if (char === '\\') {
      const next = text[index + 1];
      if (next === '[' || next === '(') {
        formulas++;
        index = skipTo(next === '[' ? '\\]' : '\\)', index + 2);
        out += ' ';
        continue;
      }
      if (text.startsWith('\\verb', index) && !/[A-Za-z]/.test(text[index + 5] ?? '')) {
        const delimiter = text[index + 5] === '*' ? text[index + 6] : text[index + 5];
        const from = index + (text[index + 5] === '*' ? 7 : 6);
        index = delimiter ? skipTo(delimiter, from) : text.length;
        out += ' ';
        continue;
      }
      if (text.startsWith('\\begin', index)) {
        const { value, end } = readArgument(text, index + 6);
        const name = value.trim();
        if (MATH_ENVIRONMENTS.has(name) || SKIPPED_ENVIRONMENTS.has(name)) {
          if (MATH_ENVIRONMENTS.has(name)) formulas++;
          index = skipTo(`\\end{${name}}`, end);
          out += ' ';
          continue;
        }
      }
      // Any other command or escaped character (\$ is not a formula) is kept as it is.
      out += text.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (char === '$') {
      const display = text[index + 1] === '$';
      formulas++;
      let end = index + (display ? 2 : 1);
      while (end < text.length && text[end] !== '$') end += text[end] === '\\' ? 2 : 1;
      index = Math.min(text.length, end + (display ? 2 : 1));
      out += ' ';
      continue;
    }
    out += char;
    index++;
  }
  return { text: out, formulas };
}

/** Text left once the commands are removed; `\input` and `\include` targets are collected. */
function removeCommands(text: string, includes: string[]): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '\\') {
      COMMAND_NAME.lastIndex = index + 1;
      const match = COMMAND_NAME.exec(text);
      if (!match) {
        const next = text[index + 1] ?? '';
        // Accented letter written with a command (\'e, \^{o}): the letter stays in its word.
        const accented = /^\{?(\p{L})\}?/u.exec(text.slice(index + 2, index + 5));
        if (ACCENTS.has(next) && accented) {
          out += accented[1];
          index += 2 + accented[0].length;
        } else {
          // \\ (new line, maybe with a length), \&, \%, \, … separate words.
          index = next === '\\' ? skipOptions(text, index + 2) : index + 2;
          out += ' ';
        }
        continue;
      }
      const name = match[0].replace(/\*$/, '');
      index = skipOptions(text, index + 1 + match[0].length);
      let groups = DROPPED[name] ?? 0;
      if (name === 'input' || name === 'include') {
        const { value, end } = readArgument(text, index);
        if (value.trim()) includes.push(value.trim());
        index = end;
        groups = 0;
      } else if (name === 'begin') {
        const { value, end } = readArgument(text, index);
        index = skipOptions(text, end);
        groups = ENVIRONMENT_SETTINGS[value.trim()] ?? 0;
      }
      for (let group = 0; group < groups; group++) {
        const start = skipSpaces(text, index);
        if (text[start] !== '{') break;
        index = skipOptions(text, closeOf(text, start, '{', '}'));
      }
      out += ' ';
      continue;
    }
    // Braces only group: "Th{\'e}se" stays one word.
    if (char === '~' || char === '&') out += ' ';
    else if (char !== '{' && char !== '}') out += char;
    index++;
  }
  return out;
}

/** Words of a text without its commands: letters and digits, with ' ’ - inside a word. */
export function countPlainWords(text: string): number {
  return text.match(WORD)?.length ?? 0;
}

/** Words, formulas and included files of one LaTeX text (no preamble, no comments). */
export function countLatexWords(text: string): {
  words: number;
  formulas: number;
  includes: string[];
} {
  const math = removeMath(text);
  const includes: string[] = [];
  const plain = removeCommands(math.text, includes);
  return { words: countPlainWords(plain), formulas: math.formulas, includes };
}

/** Body of the main file: between \begin{document} and \end{document} when present. */
function bodyOf(text: string): string {
  const begin = text.indexOf('\\begin{document}');
  if (begin < 0) return text;
  const start = begin + '\\begin{document}'.length;
  const end = text.indexOf('\\end{document}', start);
  return text.slice(start, end < 0 ? text.length : end);
}

/** Normalized project path of `name` seen from `folder` ("./a", "b/../c"), or null. */
function joinPath(folder: string, name: string): string | null {
  const parts: string[] = [];
  for (const part of `${folder ? `${folder}/` : ''}${name}`.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.pop()) return null;
    } else parts.push(part);
  }
  return parts.length ? parts.join('/') : null;
}

/**
 * Words of the document whose main file is `mainPath`: its body, then the files it includes
 * with `\input` or `\include` (".tex" added when missing, looked for next to the main file, then
 * from the root of the project), each file read once. `read` gives the text of a project file,
 * undefined when there is no such file. Null when the main file itself is missing.
 */
export function countDocumentWords(
  mainPath: string,
  read: (path: string) => string | undefined,
): WordCount | null {
  const main = read(mainPath);
  if (main === undefined) return null;
  const mainFolder = mainPath.includes('/') ? mainPath.slice(0, mainPath.lastIndexOf('/')) : '';
  const result: WordCount = { words: 0, formulas: 0, files: [], missing: [] };
  const seen = new Set<string>();

  const resolve = (name: string): { path: string; text: string } | null => {
    const candidates = [mainFolder, '']
      .flatMap((folder) => [joinPath(folder, name), joinPath(folder, `${name}.tex`)])
      .filter((path): path is string => path !== null);
    for (const path of candidates) {
      const text = read(path);
      if (text !== undefined) return { path, text };
    }
    return null;
  };

  const visit = (path: string, text: string, isMain: boolean) => {
    seen.add(path);
    result.files.push(path);
    const clean = blankComments(text);
    const counted = countLatexWords(isMain ? bodyOf(clean) : clean);
    result.words += counted.words;
    result.formulas += counted.formulas;
    for (const name of counted.includes) {
      const found = resolve(name);
      if (!found) {
        if (!result.missing.includes(name)) result.missing.push(name);
      } else if (!seen.has(found.path)) {
        visit(found.path, found.text, false);
      }
    }
  };

  visit(mainPath, main, true);
  return result;
}
