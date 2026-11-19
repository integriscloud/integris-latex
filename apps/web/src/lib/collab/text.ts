import diff from 'fast-diff';
import type * as Y from 'yjs';

/**
 * Turns the shared text into `next` with the smallest insertions and deletions, in one
 * transaction (one undo step): the cursors of the others stay where they are.
 */
export function replaceText(text: Y.Text, next: string): void {
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
  });
}
