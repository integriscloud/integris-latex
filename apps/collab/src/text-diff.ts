import { FILE_TEXT_NAME } from '@integris/shared';
import diff from 'fast-diff';
import * as Y from 'yjs';

/**
 * Turns `text` into `next` with the smallest insertions and deletions, in one transaction.
 * Content replaced outside the editor (upload, restoration) is applied this way, never by
 * recreating the document: clients holding offline changes then merge without duplicated text.
 */
export function applyText(text: Y.Text, next: string, origin: unknown): void {
  const current = text.toString();
  if (current === next) return;
  text.doc!.transact(() => {
    let index = 0;
    for (const [operation, value] of diff(current, next)) {
      if (operation === diff.EQUAL) {
        index += value.length;
      } else if (operation === diff.DELETE) {
        text.delete(index, value.length);
      } else {
        text.insert(index, value);
        index += value.length;
      }
    }
  }, origin);
}

/**
 * Three-way merge of a text replaced outside the editor. The change from `base` (the state whose
 * text was last read from or written to storage) to `next` is computed on a copy of `base`, then
 * applied to `document` as a concurrent update: edits made since `base` are kept. Returns the
 * new base (the state holding exactly `next`).
 */
export function mergeText(
  document: Y.Doc,
  base: Uint8Array,
  next: string,
  origin: unknown,
): Uint8Array {
  const copy = new Y.Doc();
  try {
    Y.applyUpdate(copy, base);
    const before = Y.encodeStateVector(copy);
    applyText(copy.getText(FILE_TEXT_NAME), next, null);
    Y.applyUpdate(document, Y.encodeStateAsUpdate(copy, before), origin);
    return Y.encodeStateAsUpdate(copy);
  } finally {
    copy.destroy();
  }
}
