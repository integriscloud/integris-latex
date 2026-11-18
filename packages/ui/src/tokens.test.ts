import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('design tokens', () => {
  it('stay identical to the designer delivery in docs/design/tokens', () => {
    expect(read('./tokens.css')).toBe(read('../../../docs/design/tokens/tokens.css'));
  });
});
