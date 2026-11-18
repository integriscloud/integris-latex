import { describe, expect, it } from 'vitest';
import { insertDigits, onlyDigits, typedText } from './digits';

describe('OTP digits', () => {
  it('keeps digits only', () => {
    expect(onlyDigits('48 27-13', 6)).toBe('482713');
    expect(onlyDigits('1234567', 6)).toBe('123456');
  });

  it('types one digit at a position', () => {
    expect(insertDigits('', 0, '4', 6)).toBe('4');
    expect(insertDigits('48', 2, '2', 6)).toBe('482');
  });

  it('spreads a pasted code from the focused box', () => {
    expect(insertDigits('', 0, '482713', 6)).toBe('482713');
    expect(insertDigits('9', 1, '1234567', 6)).toBe('912345');
  });

  it('clears a digit', () => {
    expect(insertDigits('482', 2, '', 6)).toBe('48');
  });

  it('reads the new digit typed next to an existing one', () => {
    expect(typedText('4', '47')).toBe('7');
    expect(typedText('4', '74')).toBe('7');
    expect(typedText('4', '4')).toBe('4');
    expect(typedText(undefined, '482713')).toBe('482713');
  });
});
