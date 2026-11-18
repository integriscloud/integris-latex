import { describe, expect, it } from 'vitest';
import { formatBytes } from './format';

describe('formatBytes', () => {
  it('uses binary units in the language of the page', () => {
    expect(formatBytes(512, 'fr')).toBe('512\u00a0octets');
    expect(formatBytes(1536, 'fr')).toBe('1,5\u00a0Ko');
    expect(formatBytes(100 * 1024 * 1024, 'fr')).toBe('100\u00a0Mo');
    expect(formatBytes(2 * 1024 ** 3, 'en')).toBe('2\u00a0GB');
    expect(formatBytes(10.25 * 1024 * 1024, 'en')).toBe('10.3\u00a0MB');
  });
});
