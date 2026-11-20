import { describe, expect, it } from 'vitest';
import { durationParts, formatBytes, relativeOrNow } from './format';

describe('formatBytes', () => {
  it('uses binary units in the language of the page', () => {
    expect(formatBytes(512, 'fr')).toBe('512\u00a0octets');
    expect(formatBytes(1536, 'fr')).toBe('1,5\u00a0Ko');
    expect(formatBytes(100 * 1024 * 1024, 'fr')).toBe('100\u00a0Mo');
    expect(formatBytes(2 * 1024 ** 3, 'en')).toBe('2\u00a0GB');
    expect(formatBytes(10.25 * 1024 * 1024, 'en')).toBe('10.3\u00a0MB');
  });
});

describe('relativeOrNow', () => {
  const format = {
    relativeTime: (date: Date, now: Date) =>
      new Intl.RelativeTimeFormat('fr', { numeric: 'auto' }).format(
        Math.round((date.getTime() - now.getTime()) / 60_000),
        'minute',
      ),
  };
  const now = new Date('2026-11-19T12:00:00Z');
  const at = (seconds: number) => new Date(now.getTime() + seconds * 1000);

  it("says « à l'instant » under a minute and for a date in the future (clock offset)", () => {
    expect(relativeOrNow(format, at(6), now, "à l'instant")).toBe("à l'instant");
    expect(relativeOrNow(format, at(3600), now, "à l'instant")).toBe("à l'instant");
    expect(relativeOrNow(format, at(-59), now, "à l'instant")).toBe("à l'instant");
  });

  it('gives the relative date from one minute on', () => {
    expect(relativeOrNow(format, at(-120), now, "à l'instant")).toBe('il y a 2 minutes');
  });
});

describe('durationParts', () => {
  it('splits exactly, never rounding up', () => {
    expect(durationParts(2)).toEqual({ unit: 'seconds', seconds: 2 });
    expect(durationParts(59.9)).toEqual({ unit: 'seconds', seconds: 59 });
    expect(durationParts(60)).toEqual({ unit: 'minutes', minutes: 1, seconds: 0 });
    expect(durationParts(90)).toEqual({ unit: 'minutes', minutes: 1, seconds: 30 });
    expect(durationParts(2 * 3600 + 5 * 60 + 59)).toEqual({
      unit: 'hours',
      hours: 2,
      minutes: '05',
    });
    expect(durationParts(-3)).toEqual({ unit: 'seconds', seconds: 0 });
  });
});
