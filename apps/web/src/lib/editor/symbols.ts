import { blankComments, readGroup } from './outline';

/** A label, citation key or command found in a project file. */
export interface ProjectSymbol {
  name: string;
  /** Path of the file that defines it. */
  path: string;
  /** Short context shown in the completion list (section title, entry title…). */
  detail?: string;
}

const LABEL = /\\label\s*\{([^{}\s]+)\}/g;
const BIB_ENTRY = /@([a-zA-Z]+)\s*[{(]\s*([^\s,{}()]+)\s*,/g;
const NEW_COMMAND =
  /\\(?:(?:re)?newcommand\*?|providecommand\*?|DeclareMathOperator\*?|DeclareRobustCommand\*?)\s*\{?\s*\\([a-zA-Z@]+)\s*\}?(?:\s*\[(\d)\])?/g;
const DEF = /\\def\s*\\([a-zA-Z@]+)/g;
const NEW_ENVIRONMENT = /\\(?:re)?newenvironment\*?\s*\{([a-zA-Z*@]+)\}/g;

/** `\label{…}` keys of a LaTeX file (commented-out labels excluded). */
export function extractLabels(text: string, path: string): ProjectSymbol[] {
  return [...blankComments(text).matchAll(LABEL)].map((match) => ({ name: match[1]!, path }));
}

/** Entry keys of a BibTeX file, with their title when present. */
export function extractBibKeys(text: string, path: string): ProjectSymbol[] {
  const keys: ProjectSymbol[] = [];
  for (const match of text.matchAll(BIB_ENTRY)) {
    const type = match[1]!.toLowerCase();
    if (type === 'comment' || type === 'string' || type === 'preamble') continue;
    const rest = text.slice(match.index + match[0].length, match.index + match[0].length + 2000);
    const title = /\btitle\s*=\s*[{"]/i.exec(rest);
    const value = title ? readGroup(rest, title.index + title[0].length, 300) : null;
    keys.push({
      name: match[2]!,
      path,
      detail: value?.replace(/[{}"]/g, '').replace(/\s+/g, ' ').trim() || undefined,
    });
  }
  return keys;
}

/** Commands and environments defined in a file (`\newcommand`, `\newenvironment`…). */
export function extractDefinitions(
  text: string,
  path: string,
): { commands: (ProjectSymbol & { args: number })[]; environments: ProjectSymbol[] } {
  const source = blankComments(text);
  const commands = [
    ...[...source.matchAll(NEW_COMMAND)].map((match) => ({
      name: match[1]!,
      path,
      args: Number(match[2] ?? 0),
    })),
    ...[...source.matchAll(DEF)].map((match) => ({ name: match[1]!, path, args: 0 })),
  ];
  const environments = [...source.matchAll(NEW_ENVIRONMENT)].map((match) => ({
    name: match[1]!,
    path,
  }));
  return { commands, environments };
}

/** Removes duplicates by name, keeping the first one. */
export function uniqueByName<T extends { name: string }>(items: Iterable<T>): T[] {
  const seen = new Map<string, T>();
  for (const item of items) if (!seen.has(item.name)) seen.set(item.name, item);
  return [...seen.values()];
}
