/** Keeps only digits, up to `length`, e.g. a pasted "48 27 13" gives "482713". */
export function onlyDigits(value: string, length: number): string {
  return value.replace(/\D/g, '').slice(0, length);
}

/** Puts `typed` at `index` in `code`, spreading several digits (paste, SMS autofill). */
export function insertDigits(code: string, index: number, typed: string, length: number): string {
  const digits = onlyDigits(typed, length);
  const chars = code.padEnd(length, ' ').split('');
  if (digits.length === 0) {
    chars[index] = ' ';
  } else {
    for (let i = 0; i < digits.length && index + i < length; i++) chars[index + i] = digits[i]!;
  }
  return chars.join('').trimEnd();
}

/**
 * What the user typed in a box that already held `previous`: browsers keep the old digit when the
 * caret was before or after it instead of replacing it.
 */
export function typedText(previous: string | undefined, raw: string): string {
  const old = previous?.trim();
  if (!old || raw.length !== 2) return raw;
  if (raw.startsWith(old)) return raw.slice(1);
  if (raw.endsWith(old)) return raw.slice(0, 1);
  return raw;
}
