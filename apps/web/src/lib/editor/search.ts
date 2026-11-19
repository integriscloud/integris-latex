/** Options of a search in one file or in the whole project. */
export interface SearchOptions {
  caseSensitive: boolean;
  regexp: boolean;
  wholeWord: boolean;
}

export interface SearchMatch {
  /** 1-based line and column (in UTF-16 units) of the match. */
  line: number;
  column: number;
  from: number;
  to: number;
  /** The line, trimmed around the match for display. */
  preview: { before: string; match: string; after: string };
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A letter, digit or underscore: what may not touch a whole-word match. */
const WORD = /[\p{L}\p{N}_]/u;

/**
 * Patterns of whole-word searches. They only check the end of a match: the start is checked by
 * `matchesOf`, because a lookbehind (`(?<!…)`) throws in Safari before 16.4 (docs/spec.md,
 * "Navigateurs").
 */
const wholeWordPatterns = new WeakSet<RegExp>();

/** The regular expression of a search, or null when the query is empty or not a valid regexp. */
export function searchPattern(query: string, options: SearchOptions): RegExp | null {
  if (!query) return null;
  let source = options.regexp ? query : escapeRegExp(query);
  if (options.wholeWord) source = `(?:${source})(?![\\p{L}\\p{N}_])`;
  try {
    const pattern = new RegExp(source, `gu${options.caseSensitive ? '' : 'i'}m`);
    // A pattern matching the empty string would find a match at every position.
    if (pattern.test('')) return null;
    pattern.lastIndex = 0;
    if (options.wholeWord) wholeWordPatterns.add(pattern);
    return pattern;
  } catch {
    return null;
  }
}

/** Length in UTF-16 units of the code point at `index`. */
const codePointLength = (text: string, index: number) =>
  (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;

/** Whether the code point just before `index` is a letter, a digit or an underscore. */
function wordBefore(text: string, index: number): boolean {
  if (index === 0) return false;
  const low = text.charCodeAt(index - 1);
  const start = low >= 0xdc00 && low <= 0xdfff && index >= 2 ? index - 2 : index - 1;
  return WORD.test(String.fromCodePoint(text.codePointAt(start)!));
}

/**
 * Every match of a pattern, like `matchAll`. For a whole-word pattern, a match preceded by a
 * letter, a digit or an underscore is skipped and the search goes on from the next code point,
 * exactly as the engine does when a lookbehind fails.
 */
function* matchesOf(text: string, pattern: RegExp): Generator<RegExpExecArray> {
  const wholeWord = wholeWordPatterns.has(pattern);
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (wholeWord && wordBefore(text, match.index)) {
      pattern.lastIndex = match.index + codePointLength(text, match.index);
      continue;
    }
    // An empty match would be found again at the same place.
    if (!match[0]) pattern.lastIndex = match.index + codePointLength(text, match.index);
    yield match;
  }
  pattern.lastIndex = 0;
}

const PREVIEW = 40;

/** Matches in a text, at most `limit`. */
export function findMatches(text: string, pattern: RegExp, limit = 1000): SearchMatch[] {
  const matches: SearchMatch[] = [];
  const lineStarts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) lineStarts.push(index + 1);
  }
  let lineIndex = 0;
  for (const match of matchesOf(text, pattern)) {
    if (matches.length >= limit) break;
    const from = match.index;
    const to = from + match[0].length;
    while (lineIndex + 1 < lineStarts.length && lineStarts[lineIndex + 1]! <= from) lineIndex++;
    const lineStart = lineStarts[lineIndex]!;
    const lineEnd = (lineStarts[lineIndex + 1] ?? text.length + 1) - 1;
    const start = Math.max(lineStart, from - PREVIEW);
    const end = Math.min(lineEnd, to + PREVIEW);
    matches.push({
      line: lineIndex + 1,
      column: from - lineStart + 1,
      from,
      to,
      preview: {
        before: (start > lineStart ? '…' : '') + text.slice(start, from).trimStart(),
        match: text.slice(from, Math.min(to, lineEnd)),
        after: text.slice(Math.min(to, lineEnd), end).trimEnd() + (end < lineEnd ? '…' : ''),
      },
    });
  }
  return matches;
}

/**
 * Replaces every match. With a regexp, `$1`… in the replacement refer to the groups, as in the
 * search panel of the editor; otherwise the replacement is literal.
 */
export function replaceAll(
  text: string,
  pattern: RegExp,
  replacement: string,
  options: SearchOptions,
): { text: string; count: number } {
  let count = 0;
  let result = '';
  let last = 0;
  for (const match of matchesOf(text, pattern)) {
    count++;
    result += text.slice(last, match.index);
    result += options.regexp ? expandGroups(replacement, match) : replacement;
    last = match.index + match[0].length;
  }
  return { text: result + text.slice(last), count };
}

/** `$$`, `$&` and `$1`… of a regexp replacement; an unknown group stays as written. */
function expandGroups(replacement: string, match: RegExpExecArray): string {
  const groups = match.slice(1);
  return replacement.replace(/\$(\$|&|\d{1,2})/g, (whole, ref: string) => {
    if (ref === '$') return '$';
    if (ref === '&') return match[0];
    const number = Number(ref);
    return number >= 1 && number <= groups.length ? (groups[number - 1] ?? '') : whole;
  });
}
