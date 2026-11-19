import { type Extension, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';

/** A commented selection in the open file. */
export interface CommentMark {
  id: string;
  from: number;
  to: number;
  /** The comment shown in the panel. */
  active: boolean;
}

export const setCommentMarks = StateEffect.define<readonly CommentMark[]>();

const markOf = (active: boolean) =>
  Decoration.mark({
    class: active ? 'cm-comment cm-comment-active' : 'cm-comment',
  });

function build(marks: readonly CommentMark[], length: number): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  // Ranges come from the shared text and may be a step ahead of the view: kept inside it.
  const sorted = marks
    .map((mark) => ({ ...mark, from: Math.min(mark.from, length), to: Math.min(mark.to, length) }))
    .filter((mark) => mark.to > mark.from)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  for (const mark of sorted) builder.add(mark.from, mark.to, markOf(mark.active));
  return builder.finish();
}

/** Ids of the comments at a position of the text (a click in the code). */
function idsAt(field: { marks: readonly CommentMark[] }, position: number): string[] {
  return field.marks
    .filter((mark) => mark.from <= position && position <= mark.to)
    .map((mark) => mark.id);
}

/**
 * Highlights the commented selections. They follow the edits between two updates from the
 * shared text (mapped through the changes), then the anchors give their exact place again.
 */
export function commentMarks(onClick: (id: string) => void): Extension {
  const field = StateField.define<{ marks: readonly CommentMark[]; decorations: DecorationSet }>({
    create: () => ({ marks: [], decorations: Decoration.none }),
    update(value, transaction) {
      let next = value;
      if (transaction.docChanged) {
        next = {
          marks: value.marks.map((mark) => ({
            ...mark,
            from: transaction.changes.mapPos(mark.from, 1),
            to: transaction.changes.mapPos(mark.to, -1),
          })),
          decorations: value.decorations.map(transaction.changes),
        };
      }
      for (const effect of transaction.effects) {
        if (effect.is(setCommentMarks)) {
          next = {
            marks: effect.value,
            decorations: build(effect.value, transaction.state.doc.length),
          };
        }
      }
      return next;
    },
    provide: (state) => EditorView.decorations.from(state, (value) => value.decorations),
  });
  return [
    field,
    EditorView.domEventHandlers({
      click(event, view) {
        const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (position === null) return false;
        const [id] = idsAt(view.state.field(field), position);
        if (id) onClick(id);
        // The click still moves the cursor.
        return false;
      },
    }),
  ];
}
