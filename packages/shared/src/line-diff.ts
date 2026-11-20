import type { DiffHunk, DiffLine, DiffSegment } from './submissions.js';

/**
 * Largest file compared line by line, and most changed lines (else "too large"). The work is
 * O((N+M)·D) in time and O(D²) in memory: at most about 40 000 × 2 000 steps and 16 MB.
 */
export const DIFF_MAX_LINES = 20_000;
export const DIFF_MAX_EDITS = 2_000;
/** Longest line (in words and separators) compared word by word, and most word changes. */
export const WORD_DIFF_MAX_TOKENS = 1_000;
export const WORD_DIFF_MAX_EDITS = 200;
/** Characters compared word by word in one file at most (the next lines stay unmarked). */
export const WORD_DIFF_BUDGET = 200_000;

export interface LineDiff {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  tooLarge: boolean;
}

/** Lines of a text, without the line break of the last one. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

type Op = 'same' | 'added' | 'removed';

/**
 * Shortest edit script between two line lists (Myers, O((N+M)·D)), after the common start and
 * end are set aside. Null when more than `maxEdits` lines differ.
 */
function editScript(a: string[], b: string[], maxEdits: number): Op[] | null {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head: Op[] = new Array<Op>(start).fill('same');
  const tail: Op[] = new Array<Op>(a.length - endA).fill('same');
  const n = endA - start;
  const m = endB - start;
  if (n === 0) return [...head, ...new Array<Op>(m).fill('added'), ...tail];
  if (m === 0) return [...head, ...new Array<Op>(n).fill('removed'), ...tail];

  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // Before round d, only the diagonals -d-1…d+1 matter: trace[d] keeps that slice (index k+d+1).
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[start + x] === b[start + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return null;

  // Walks the trace back from the end.
  const middle: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const previous = trace[d]!;
    const at = (diagonal: number) => previous[diagonal + d + 1]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      middle.push('same');
      x--;
      y--;
    }
    middle.push(down ? 'added' : 'removed');
    if (down) y--;
    else x--;
  }
  while (x > 0 && y > 0) {
    middle.push('same');
    x--;
    y--;
  }
  middle.reverse();
  return [...head, ...middle, ...tail];
}

/**
 * Line-by-line difference of two texts, as hunks of changed lines with `context` lines around
 * them (docs/spec.md, "Comparaison"). Very large files or changes come back `tooLarge`.
 */
export function diffTexts(before: string, after: string, context = 3): LineDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) {
    return { hunks: [], added: 0, removed: 0, tooLarge: true };
  }
  const ops = editScript(a, b, DIFF_MAX_EDITS);
  if (!ops) return { hunks: [], added: 0, removed: 0, tooLarge: true };

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op === 'same') {
      lines.push({ type: 'same', text: a[i]!, from: i + 1, to: j + 1 });
      i++;
      j++;
    } else if (op === 'removed') {
      lines.push({ type: 'removed', text: a[i]!, from: i + 1, to: null });
      i++;
      removed++;
    } else {
      lines.push({ type: 'added', text: b[j]!, from: null, to: j + 1 });
      j++;
      added++;
    }
  }

  markWords(lines);

  // Changed lines with their context; hunks closer than twice the context are merged.
  const hunks: DiffHunk[] = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index]!.type === 'same') {
      index++;
      continue;
    }
    let end = index;
    for (let scan = index; scan < lines.length; scan++) {
      if (lines[scan]!.type !== 'same') end = scan;
      else if (scan - end > 2 * context) break;
    }
    const from = Math.max(0, index - context);
    const to = Math.min(lines.length, end + context + 1);
    hunks.push({ lines: lines.slice(from, to) });
    index = to;
  }
  return { hunks, added, removed, tooLarge: false };
}

/** Words, runs of spaces, and every other character on its own (a LaTeX command stays whole). */
const TOKEN = /\\?[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;

/** Consecutive tokens of the same kind joined. */
function segments(tokens: string[], changed: boolean[]): DiffSegment[] {
  const out: DiffSegment[] = [];
  tokens.forEach((text, index) => {
    const last = out[out.length - 1];
    if (last && last.changed === changed[index]) last.text += text;
    else out.push({ text, changed: changed[index]! });
  });
  return out;
}

/**
 * Words changed inside a changed line: each run of removed lines followed by added lines is
 * paired line by line, and the paired lines are compared word by word. Lines with little in
 * common keep no segments (the whole line is the change).
 */
function markWords(lines: DiffLine[]) {
  let budget = WORD_DIFF_BUDGET;
  let index = 0;
  while (index < lines.length) {
    if (lines[index]!.type !== 'removed') {
      index++;
      continue;
    }
    const removedStart = index;
    while (index < lines.length && lines[index]!.type === 'removed') index++;
    const addedStart = index;
    while (index < lines.length && lines[index]!.type === 'added') index++;
    const pairs = Math.min(addedStart - removedStart, index - addedStart);
    for (let pair = 0; pair < pairs; pair++) {
      const older = lines[removedStart + pair]!;
      const newer = lines[addedStart + pair]!;
      budget -= older.text.length + newer.text.length;
      if (budget < 0) return;
      const marked = wordDiff(older.text, newer.text);
      if (!marked) continue;
      older.segments = marked.older;
      newer.segments = marked.newer;
    }
  }
}

/** Word-by-word difference of two lines, or null when they have too little in common. */
export function wordDiff(
  before: string,
  after: string,
): { older: DiffSegment[]; newer: DiffSegment[] } | null {
  const a = before.match(TOKEN) ?? [];
  const b = after.match(TOKEN) ?? [];
  if (a.length > WORD_DIFF_MAX_TOKENS || b.length > WORD_DIFF_MAX_TOKENS) return null;
  const ops = editScript(a, b, WORD_DIFF_MAX_EDITS);
  if (!ops) return null;
  const olderChanged: boolean[] = [];
  const newerChanged: boolean[] = [];
  let common = 0;
  for (const op of ops) {
    if (op === 'same') {
      common += a[olderChanged.length]!.trim() ? a[olderChanged.length]!.length : 0;
      olderChanged.push(false);
      newerChanged.push(false);
    } else if (op === 'removed') olderChanged.push(true);
    else newerChanged.push(true);
  }
  // Half of the longer line (spaces aside) at least is shared, else the lines are just different.
  const longest = Math.max(before.replace(/\s/g, '').length, after.replace(/\s/g, '').length);
  if (common * 2 < longest) return null;
  return { older: segments(a, olderChanged), newer: segments(b, newerChanged) };
}
