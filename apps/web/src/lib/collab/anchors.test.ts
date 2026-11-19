import { commentAnchorSchema } from '@integris/shared';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { anchorOf, applyReplacement, rangeOf, revertReplacement } from './anchors';

/** Two people on the same document, kept in sync like the collaboration server does. */
function pair(initial: string) {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on('update', (update: Uint8Array) => Y.applyUpdate(b, update));
  b.on('update', (update: Uint8Array) => Y.applyUpdate(a, update));
  a.getText('content').insert(0, initial);
  return { a: a.getText('content'), b: b.getText('content') };
}

const quoted = (text: Y.Text, anchor: ReturnType<typeof anchorOf>) => {
  const range = rangeOf(text, anchor);
  return range ? text.toString().slice(range.from, range.to) : null;
};

describe('comment anchors', () => {
  const sentence = 'Les débits mesurés entre mars et juin baissent.';
  const target = 'mesurés entre mars et juin';

  it('is a pair of relative positions the API accepts', () => {
    const { a } = pair(sentence);
    const from = sentence.indexOf(target);
    const anchor = anchorOf(a, from, from + target.length);
    expect(commentAnchorSchema.safeParse(JSON.parse(JSON.stringify(anchor))).success).toBe(true);
    expect(quoted(a, anchor)).toBe(target);
  });

  it('stays on the same words while someone else types before, after and inside', () => {
    const { a, b } = pair(sentence);
    const from = sentence.indexOf(target);
    const anchor = anchorOf(a, from, from + target.length);
    // The other person types before the selection, after it, and at its edges.
    b.insert(0, 'En 2025, ');
    b.insert(b.toString().length, ' Source : DGRE.');
    expect(quoted(a, anchor)).toBe(target);
    expect(quoted(b, anchor)).toBe(target);
    const inside = b.toString().indexOf('entre');
    b.insert(inside, 'observés ');
    expect(quoted(a, anchor)).toBe('mesurés observés entre mars et juin');
    // Text typed right before the start and right after the end stays outside.
    const start = rangeOf(b, anchor)!.from;
    b.insert(start, '« ');
    b.insert(rangeOf(b, anchor)!.to, ' »');
    expect(quoted(a, anchor)).toBe('mesurés observés entre mars et juin');
  });

  it('is gone when its text is deleted', () => {
    const { a, b } = pair(sentence);
    const from = sentence.indexOf(target);
    const anchor = anchorOf(a, from, from + target.length);
    b.delete(from - 1, target.length + 2);
    expect(rangeOf(a, anchor)).toBeNull();
  });

  it('applies a proposal in one change, anchors the new text, and can be undone', () => {
    const { a, b } = pair(sentence);
    const from = sentence.indexOf(target);
    const anchor = anchorOf(a, from, from + target.length);
    b.insert(0, 'En 2025, ');
    const applied = applyReplacement(a, anchor, 'relevés à Wayen');
    expect(applied?.previous).toBe(target);
    expect(b.toString()).toBe('En 2025, Les débits relevés à Wayen baissent.');
    expect(quoted(b, applied!.anchor)).toBe('relevés à Wayen');
    revertReplacement(a, applied!.anchor, applied!.previous, applied!.from);
    expect(b.toString()).toBe(`En 2025, ${sentence}`);
  });

  it('applies an empty proposal as a deletion', () => {
    const { a } = pair(sentence);
    const anchor = anchorOf(a, 4, 11);
    const applied = applyReplacement(a, anchor, '');
    expect(a.toString()).toBe('Les mesurés entre mars et juin baissent.');
    expect(rangeOf(a, applied!.anchor)).toBeNull();
  });
});
