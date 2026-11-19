import type { CommentAnchor } from '@integris/shared';
import * as Y from 'yjs';

/**
 * Anchor of a selection in the shared text: two Yjs relative positions. The start sticks to the
 * first selected character and the end to the last one, so text typed before, after or inside
 * the selection (by anyone, offline included) keeps the comment on the same words.
 */
export function anchorOf(text: Y.Text, from: number, to: number): CommentAnchor {
  return {
    start: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, from, 0)),
    end: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, to, -1)),
  } as CommentAnchor;
}

/**
 * Where an anchor is now in the shared text, or null when its text was deleted (or the anchor
 * belongs to another state of the document).
 */
export function rangeOf(text: Y.Text, anchor: CommentAnchor): { from: number; to: number } | null {
  const doc = text.doc;
  if (!doc) return null;
  const resolve = (position: CommentAnchor['start']) => {
    const absolute = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(position),
      doc,
    );
    return absolute && absolute.type === text ? absolute.index : null;
  };
  const from = resolve(anchor.start);
  const to = resolve(anchor.end);
  if (from === null || to === null || to <= from) return null;
  return { from, to };
}

/**
 * Replaces the anchored text by a proposal in one transaction (one undo step for the person who
 * applies it) and gives the anchor of the new text. Null when the anchored text is gone.
 */
export function applyReplacement(
  text: Y.Text,
  anchor: CommentAnchor,
  replacement: string,
): { anchor: CommentAnchor; previous: string; from: number } | null {
  const range = rangeOf(text, anchor);
  if (!range) return null;
  const previous = text.toString().slice(range.from, range.to);
  text.doc!.transact(() => {
    text.delete(range.from, range.to - range.from);
    text.insert(range.from, replacement);
  });
  // An empty proposal deletes the text: its anchor is then empty (nothing left to highlight).
  return {
    anchor: anchorOf(text, range.from, range.from + replacement.length),
    previous,
    from: range.from,
  };
}

/** Undoes a replacement refused by the server: the previous text goes back in its place. */
export function revertReplacement(
  text: Y.Text,
  anchor: CommentAnchor,
  previous: string,
  from: number,
): void {
  const range = rangeOf(text, anchor);
  text.doc!.transact(() => {
    if (range) text.delete(range.from, range.to - range.from);
    text.insert(range?.from ?? from, previous);
  });
}
