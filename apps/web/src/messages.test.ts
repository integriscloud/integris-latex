import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import en from '../messages/en.json';
import fr from '../messages/fr.json';

function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    keys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe('messages', () => {
  it('define the same keys in French and English', () => {
    expect(keys(en).sort()).toEqual(keys(fr).sort());
  });

  it('never leave a message empty', () => {
    for (const messages of [fr, en]) {
      const leaves = keys(messages).map((path) =>
        path
          .split('.')
          .reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], messages),
      );
      expect(leaves.every((leaf) => typeof leaf === 'string' && leaf.trim() !== '')).toBe(true);
    }
  });

  /**
   * A count followed by a noun always goes through an ICU plural ("1 étudiant suivi", never
   * "1 étudiants suivis"). Parameters holding formatted text (sizes, amounts) are not counts.
   */
  it('put every counted noun through an ICU plural rule', () => {
    const counts = new Set([
      'count',
      'max',
      'min',
      'total',
      'used',
      'days',
      'hours',
      'minutes',
      'seconds',
      'perHour',
      'length',
      'seats',
      'free',
      'held',
      'reserved',
      'invited',
      'errors',
      'students',
      'pages',
    ]);
    // Parameters followed by a unit or punctuation, never by a counted noun.
    const notANoun = /^((of|to|sur|à|des|cette|allowed|s|min|h)(?![\p{L}])|[%)(·:;,./-])/u;
    // Formatted sizes ({max} is "50 Mo") and the English adjective "free" after a number.
    const exceptions = new Set(['NewProject.zipHint', 'ProjectPage.uploadHint', 'Members.seats']);
    const withoutPlurals = (text: string) => {
      let previous = '';
      let current = text;
      while (previous !== current) {
        previous = current;
        current = current.replace(
          /\{\w+, (plural|select|selectordinal),(?:[^{}]|\{[^{}]*\})*\}/g,
          '#',
        );
      }
      return current;
    };
    const offending: string[] = [];
    for (const [lang, messages] of [
      ['fr', fr],
      ['en', en],
    ] as const) {
      for (const path of keys(messages)) {
        if (exceptions.has(path)) continue;
        const text = path
          .split('.')
          .reduce<unknown>(
            (node, key) => (node as Record<string, unknown>)[key],
            messages,
          ) as string;
        for (const match of withoutPlurals(text).matchAll(/\{(\w+)\}\s*([^\s{]+)/g)) {
          if (counts.has(match[1]!) && !notANoun.test(match[2]!)) offending.push(`${lang} ${path}`);
        }
      }
    }
    expect(offending).toEqual([]);
  });

  it('write one item in the singular', () => {
    const tFr = createTranslator({ locale: 'fr', messages: fr });
    const tEn = createTranslator({ locale: 'en', messages: en });
    expect(tFr('SupervisionDashboard.count', { count: 1, max: 30 })).toBe(
      '1 étudiant suivi sur 30 possibles',
    );
    expect(tFr('SupervisionDashboard.count', { count: 2, max: 30 })).toBe(
      '2 étudiants suivis sur 30 possibles',
    );
    expect(tEn('SupervisionDashboard.count', { count: 1, max: 30 })).toBe(
      '1 student followed of 30 allowed',
    );
    expect(tFr('Members.seats', { held: 1, total: 10, reserved: 1, free: 1 })).toBe(
      '1 siège occupé sur 10 · 1 réservé par une invitation · 1 libre.',
    );
    expect(tFr('Billing.seats', { used: 1, total: 1 })).toBe('1 sur 1 siège occupé');
    expect(tFr('Editor.hourFull', { perHour: 1 })).toBe("La compilation de l'heure est utilisée.");
    expect(tEn('Auth.code.incomplete', { length: 6 })).toBe('Enter the 6 digits of the code.');
    expect(tFr('SupervisionAdmin.teacherWithCount', { name: 'A', count: 0, max: 1 })).toBe(
      'A (0/1 étudiant)',
    );
  });
});
