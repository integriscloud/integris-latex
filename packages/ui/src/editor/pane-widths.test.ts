import { describe, expect, it } from 'vitest';
import { clampWidths, DEFAULT_WIDTHS, parseWidths } from './pane-widths';

describe('editor pane widths', () => {
  it('defaults to about 20 % files, 45 % code, 35 % PDF', () => {
    expect(DEFAULT_WIDTHS).toMatchObject({ files: 20, pdf: 35 });
    expect(100 - DEFAULT_WIDTHS.files - DEFAULT_WIDTHS.pdf).toBe(45);
  });

  it('keeps each pane within its limits and the code at 25 % at least', () => {
    expect(clampWidths({ files: 2, pdf: 90, side: 9999 })).toEqual({
      files: 12,
      pdf: 60,
      side: 560,
    });
    expect(clampWidths({ files: 40, pdf: 50, side: 320 }, 'files')).toEqual({
      files: 25,
      pdf: 50,
      side: 320,
    });
    expect(clampWidths({ files: 40, pdf: 50, side: 320 }, 'pdf')).toEqual({
      files: 40,
      pdf: 35,
      side: 320,
    });
  });

  it('reads stored widths and ignores broken ones', () => {
    expect(parseWidths('{"files":25,"pdf":30,"side":300}')).toEqual({
      files: 25,
      pdf: 30,
      side: 300,
    });
    expect(parseWidths('{"files":"x"}')).toEqual(DEFAULT_WIDTHS);
    expect(parseWidths('not json')).toEqual(DEFAULT_WIDTHS);
    expect(parseWidths(null)).toEqual(DEFAULT_WIDTHS);
  });
});
