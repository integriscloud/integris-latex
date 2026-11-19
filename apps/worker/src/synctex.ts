import { projectPathOf, type SynctexIndex } from '@integris/shared';
import { gunzipSync } from 'node:zlib';

/** Decompressed SyncTeX data read at most (an 80-page thesis is a few megabytes). */
const MAX_SYNCTEX_BYTES = 128 * 1024 * 1024;
/** Project inputs and boxes kept at most. */
const MAX_INPUTS = 5000;
const MAX_BOXES = 2_000_000;
/** TeX scaled points in one PDF point (65536 sp per TeX point, 72.27 TeX points per inch). */
const SP_PER_BP = 65781.76;

// "(tag,line[,column]:h,v:W,H,D" (hbox), "h…" (void hbox), "x tag,line:h,v" (current point), "$…".
const RECORD = /^([(hx$])(\d+),(\d+)(?:,-?\d+)?:(-?\d+),(-?\d+)(?::(-?\d+),(-?\d+),(-?\d+))?/;

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * Builds the compact SyncTeX index of a compilation (packages/shared, `SynctexIndex`) from the
 * `.synctex.gz` written in the sandbox. Only horizontal boxes and points of project files are
 * kept: the browser needs them for both directions (code → PDF, PDF → code). Returns null when
 * the file cannot be read or holds nothing of the project.
 */
export function buildSynctexIndex(compressed: Uint8Array): SynctexIndex | null {
  let text: string;
  try {
    text = gunzipSync(compressed, { maxOutputLength: MAX_SYNCTEX_BYTES }).toString('utf8');
  } catch {
    return null;
  }

  let unit = 1;
  let xOffset = 0;
  let yOffset = 0;
  const inputs: string[] = [];
  const inputIndex = new Map<string, number>();
  /** SyncTeX tag → index in `inputs`, for project files only. */
  const tags = new Map<number, number>();
  const pages: SynctexIndex['pages'] = [];
  let page: SynctexIndex['pages'][number] | null = null;
  let boxes = 0;

  for (const line of text.split('\n')) {
    if (line.startsWith('Input:')) {
      const match = line.match(/^Input:(\d+):(.*)$/);
      const path = match?.[2] ? projectPathOf(match[2]) : null;
      if (match && path && /\.(tex|sty|cls|bib|txt|md)$/i.test(path)) {
        let index = inputIndex.get(path);
        if (index === undefined && inputs.length < MAX_INPUTS) {
          index = inputs.push(path) - 1;
          inputIndex.set(path, index);
        }
        if (index !== undefined) tags.set(Number(match[1]), index);
      }
    } else if (line.startsWith('Unit:')) {
      unit = Number(line.slice(5)) || 1;
    } else if (line.startsWith('X Offset:')) {
      xOffset = Number(line.slice(9)) || 0;
    } else if (line.startsWith('Y Offset:')) {
      yOffset = Number(line.slice(9)) || 0;
    } else if (line.startsWith('{')) {
      const number = Number(line.slice(1));
      if (!Number.isInteger(number) || number < 1 || number > 100_000) return null;
      page = [];
      pages[number - 1] = page;
    } else if (line.startsWith('}')) {
      page = null;
    } else if (page && boxes < MAX_BOXES) {
      const match = line.match(RECORD);
      if (!match) continue;
      const input = tags.get(Number(match[2]));
      if (input === undefined) continue;
      const scale = (value: string | undefined, offset = 0) =>
        round((Number(value ?? 0) * unit + offset) / SP_PER_BP);
      page.push([
        input,
        Number(match[3]),
        scale(match[4], xOffset),
        scale(match[5], yOffset),
        scale(match[6]),
        scale(match[7]),
        scale(match[8]),
      ]);
      boxes++;
    }
  }
  if (!inputs.length) return null;
  // Pages without a box (or missing numbers) are empty lists, not holes.
  return { inputs, pages: Array.from(pages, (entries) => entries ?? []) };
}
