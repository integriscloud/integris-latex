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
});
