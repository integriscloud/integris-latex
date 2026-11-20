import { describe, expect, it } from 'vitest';
import { usageLevel, usagePeriodStart } from './usage.js';

describe('usage levels', () => {
  it('warns from 80 % and blocks at 100 %; unlimited is always ok', () => {
    expect(usageLevel(2, 3)).toBe('ok');
    expect(usageLevel(24, 30)).toBe('warn');
    expect(usageLevel(30, 30)).toBe('full');
    expect(usageLevel(31, 30)).toBe('full');
    expect(usageLevel(1_000, null)).toBe('ok');
  });

  it('counts by calendar month in UTC', () => {
    expect(usagePeriodStart(new Date('2026-11-30T23:59:59Z')).toISOString()).toBe(
      '2026-11-01T00:00:00.000Z',
    );
  });
});
