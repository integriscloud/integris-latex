import { describe, expect, it } from 'vitest';
import { dialCodeOf, formatPhone, normalizePhone, otpRequestSchema, signupSchema } from './auth.js';

describe('normalizePhone', () => {
  it('prefixes a local number with the chosen dial code', () => {
    expect(normalizePhone('70 12 34 56', '226')).toBe('+22670123456');
    expect(normalizePhone('07.08.09.10.11', '225')).toBe('+2250708091011');
  });

  it('keeps an explicit international prefix', () => {
    expect(normalizePhone('+33 6 12 34 56 78', '226')).toBe('+33612345678');
    expect(normalizePhone('0033612345678', '226')).toBe('+33612345678');
  });

  it('rejects invalid numbers', () => {
    expect(normalizePhone('123', '226')).toBeNull();
    expect(normalizePhone('not a phone', '226')).toBeNull();
  });

  it('reads the dial code of an E.164 number', () => {
    expect(dialCodeOf('+22670123456')).toBe('226');
  });
});

describe('formatPhone', () => {
  it('shows numbers in a readable international form', () => {
    expect(formatPhone('+22670123456')).toBe('+226 70 12 34 56');
    expect(formatPhone('+2250708091011')).toBe('+225 07 08 09 10 11');
    expect(formatPhone('+221771234567')).toBe('+221 77 123 45 67');
    expect(formatPhone('+2290197123456')).toBe('+229 01 97 12 34 56');
    expect(formatPhone('+33612345678')).toBe('+33 6 12 34 56 78');
  });

  it('leaves an unparsable value as is', () => {
    expect(formatPhone('not a number')).toBe('not a number');
  });
});

describe('auth request schemas', () => {
  it('requires the terms to be accepted at signup', () => {
    const base = {
      phone: '70123456',
      dialCode: '226',
      code: '123456',
      firstName: 'Awa',
      lastName: 'Kaboré',
      locale: 'fr',
    };
    expect(signupSchema.safeParse(base).success).toBe(false);
    expect(signupSchema.safeParse({ ...base, acceptTerms: true }).success).toBe(true);
  });

  it('rejects unknown purposes', () => {
    expect(
      otpRequestSchema.safeParse({
        phone: '70123456',
        dialCode: '226',
        purpose: 'reset',
        locale: 'fr',
      }).success,
    ).toBe(false);
  });
});
