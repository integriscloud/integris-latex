/**
 * Widths of the editor panes on wide screens. Files and PDF are percentages of the workspace (the
 * code takes the rest, about 45 % by default); the comments pane, when open, is in px.
 */
export interface PaneWidths {
  files: number;
  pdf: number;
  side: number;
}

export const DEFAULT_WIDTHS: PaneWidths = { files: 20, pdf: 35, side: 320 };

export const WIDTH_LIMITS: Record<keyof PaneWidths, [number, number]> = {
  files: [12, 40],
  pdf: [15, 60],
  side: [260, 560],
};

/** The code always keeps at least this share of the workspace. */
export const MIN_CODE_PERCENT = 25;

export const WIDTHS_STORAGE_KEY = 'integris.editor.panes.v2';

/** Widths within their limits, the code keeping its minimum share. */
export function clampWidths(widths: PaneWidths, changed?: keyof PaneWidths): PaneWidths {
  const next = { ...widths };
  for (const pane of Object.keys(WIDTH_LIMITS) as (keyof PaneWidths)[]) {
    const [min, max] = WIDTH_LIMITS[pane];
    next[pane] = Math.min(max, Math.max(min, next[pane]));
  }
  const excess = next.files + next.pdf - (100 - MIN_CODE_PERCENT);
  if (excess > 0) {
    // The pane being resized gives way; otherwise the PDF does.
    const pane = changed === 'files' ? 'files' : 'pdf';
    next[pane] = Math.max(WIDTH_LIMITS[pane][0], next[pane] - excess);
  }
  return next;
}

/** Stored widths, or the defaults when absent, invalid or from an older format. */
export function parseWidths(stored: string | null): PaneWidths {
  try {
    const value = JSON.parse(stored ?? 'null') as unknown;
    if (!value || typeof value !== 'object') return DEFAULT_WIDTHS;
    const widths = { ...DEFAULT_WIDTHS };
    for (const pane of Object.keys(DEFAULT_WIDTHS) as (keyof PaneWidths)[]) {
      const width = (value as Record<string, unknown>)[pane];
      if (typeof width === 'number' && Number.isFinite(width)) widths[pane] = width;
    }
    return clampWidths(widths);
  } catch {
    return DEFAULT_WIDTHS;
  }
}
