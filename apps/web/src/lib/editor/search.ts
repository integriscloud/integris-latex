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

/** The regular expression of a search, or null when the query is empty or not a valid regexp. */
export function searchPattern(query: string, options: SearchOptions): RegExp | null {
  if (!query) return null;
  let source = options.regexp ? query : escapeRegExp(query);
  if (options.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
  try {
    const pattern = new RegExp(source, `gu${options.caseSensitive ? '' : 'i'}m`);
    // A pattern matching the empty string would find a match at every position.
    if (pattern.test('')) return null;
    pattern.lastIndex = 0;
    return pattern;
  } catch {
    return null;
  }
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
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
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
  pattern.lastIndex = 0;
  const result = text.replace(pattern, (...args: unknown[]) => {
    count++;
    if (!options.regexp) return replacement;
    // (match, ...groups, offset, input[, namedGroups])
    const named = typeof args.at(-1) === 'object' && args.at(-1) !== null;
    const groups = args.slice(1, named ? -3 : -2) as (string | undefined)[];
    return replacement.replace(/\$(\$|&|\d{1,2})/g, (whole, ref: string) => {
      if (ref === '$') return '$';
      if (ref === '&') return args[0] as string;
      const group = groups[Number(ref) - 1];
      return Number(ref) >= 1 && Number(ref) <= groups.length ? (group ?? '') : whole;
    });
  });
  return { text: result, count };
}
