import type { SynctexIndex } from '@integris/shared';

/** A rectangle on a PDF page, in points from the top-left corner. */
export interface PdfArea {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

type Box = SynctexIndex['pages'][number][number];

const top = (box: Box) => box[3] - box[5];
const bottom = (box: Box) => box[3] + box[6];

/**
 * Code → PDF: where a line of a file was typeset. Uses the boxes of that line, or else of the
 * nearest line before it that produced something; returns the area covering them on the first
 * page where they appear, or null when the file is not in the PDF.
 */
export function forwardSearch(index: SynctexIndex, path: string, line: number): PdfArea | null {
  const input = index.inputs.indexOf(path);
  if (input === -1) return null;
  let best: { line: number; page: number } | null = null;
  index.pages.forEach((boxes, page) => {
    for (const box of boxes) {
      if (box[0] !== input || box[1] > line) continue;
      if (!best || box[1] > best.line || (box[1] === best.line && page < best.page)) {
        best = { line: box[1], page };
      }
    }
  });
  if (!best) return null;
  const { line: found, page } = best;
  const boxes = index.pages[page]!.filter((box) => box[0] === input && box[1] === found);
  const wide = boxes.filter((box) => box[4] > 0);
  const used = wide.length ? wide : boxes;
  const x = Math.min(...used.map((box) => box[2]));
  const y = Math.min(...used.map(top));
  const right = Math.max(...used.map((box) => box[2] + box[4]));
  const lower = Math.max(...used.map(bottom), y + 10);
  return { page: page + 1, x, y, width: Math.max(right - x, 20), height: lower - y };
}

/**
 * PDF → code: the file and line typeset at a point of a page. The smallest box containing the
 * point wins; otherwise the nearest box on the page.
 */
export function inverseSearch(
  index: SynctexIndex,
  page: number,
  x: number,
  y: number,
): { path: string; line: number } | null {
  const boxes = index.pages[page - 1] ?? [];
  let inside: Box | null = null;
  let nearest: Box | null = null;
  let nearestDistance = Infinity;
  for (const box of boxes) {
    const [, , left, , width] = box;
    const contains = x >= left && x <= left + width && y >= top(box) && y <= bottom(box);
    if (contains && width > 0 && (!inside || width < inside[4])) inside = box;
    const dx = x < left ? left - x : x > left + width ? x - left - width : 0;
    const dy = y < top(box) ? top(box) - y : y > bottom(box) ? y - bottom(box) : 0;
    const distance = Math.hypot(dx, dy);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = box;
    }
  }
  const box = inside ?? nearest;
  const path = box ? index.inputs[box[0]] : undefined;
  return box && path ? { path, line: box[1] } : null;
}
