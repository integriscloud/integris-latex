import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, isLocale } from './i18n.js';

describe('locales', () => {
  it('defaults to French', () => {
    expect(DEFAULT_LOCALE).toBe('fr');
  });

  it('accepts only supported locales', () => {
    expect(isLocale('en')).toBe(true);
    expect(isLocale('de')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});
