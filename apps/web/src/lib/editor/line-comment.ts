import { type Extension, StateEffect, StateField } from '@codemirror/state';
import { EditorView, gutter, GutterMarker } from '@codemirror/view';

/** A whole line to comment (from its first to its last character). */
export interface LineSelection {
  from: number;
  to: number;
  text: string;
}

const setHovered = StateEffect.define<number | null>();

/** Line under the pointer (its start position), or null. */
const hovered = StateField.define<number | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setHovered)) return effect.value;
    return value === null || !transaction.docChanged ? value : null;
  },
});

const SVG = 'http://www.w3.org/2000/svg';

/** Lucide "message-square-plus" (24 px grid, stroke 1.75), drawn without React. */
function plusIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  for (const [name, value] of Object.entries({
    width: '16',
    height: '16',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.75',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })) {
    svg.setAttribute(name, value);
  }
  for (const d of [
    'M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z',
    'M12 8v6',
    'M9 11h6',
  ]) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

class CommentLineMarker extends GutterMarker {
  constructor(
    private readonly label: string,
    private readonly onClick: () => void,
  ) {
    super();
  }

  override eq(other: CommentLineMarker) {
    return other.label === this.label;
  }

  override toDOM() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cm-commentLine';
    button.setAttribute('aria-label', this.label);
    // CodeMirror hides its margins from assistive technologies: a pointer shortcut, out of the
    // tab order. Keyboards and screen readers use "Commenter la sélection".
    button.tabIndex = -1;
    button.title = this.label;
    button.appendChild(plusIcon());
    // The editor keeps its focus and selection; the click opens the comment.
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      this.onClick();
    });
    return button;
  }
}

/** The line around a position: null for an empty line (nothing to comment). */
function lineAt(view: EditorView, position: number): LineSelection | null {
  const line = view.state.doc.lineAt(position);
  if (!line.text.trim()) return null;
  return { from: line.from, to: line.to, text: line.text };
}

/** Pointer held still on a line this long (phones): comment it. */
const LONG_PRESS_MS = 550;
const MOVE_TOLERANCE_PX = 10;

/**
 * Comment in one click: a "+" icon in the margin of the line under the pointer, and a long press
 * on a line on touch screens. Both comment the whole line; an empty line gives `null`.
 */
export function lineComments(
  label: (line: number) => string,
  onComment: (line: LineSelection | null) => void,
): Extension {
  let press: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null;
  const cancel = () => {
    if (press) clearTimeout(press.timer);
    press = null;
  };
  return [
    hovered,
    gutter({
      class: 'cm-commentGutter',
      lineMarker(view, line) {
        if (view.state.field(hovered) !== line.from) return null;
        const number = view.state.doc.lineAt(line.from).number;
        return new CommentLineMarker(label(number), () => onComment(lineAt(view, line.from)));
      },
      lineMarkerChange: (update) =>
        update.transactions.some((transaction) =>
          transaction.effects.some((effect) => effect.is(setHovered)),
        ),
      // Keeps the margin when the pointer goes from the line to its icon.
      domEventHandlers: {
        mousemove(view, line) {
          if (view.state.field(hovered) !== line.from) {
            view.dispatch({ effects: setHovered.of(line.from) });
          }
          return false;
        },
      },
    }),
    EditorView.domEventHandlers({
      mousemove(event, view) {
        const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
        const start = position === null ? null : view.state.doc.lineAt(position).from;
        if (view.state.field(hovered) !== start) view.dispatch({ effects: setHovered.of(start) });
        return false;
      },
      mouseleave(event, view) {
        // Leaving for the icon itself keeps it.
        const target = event.relatedTarget as Element | null;
        if (target?.closest?.('.cm-commentGutter')) return false;
        if (view.state.field(hovered) !== null) view.dispatch({ effects: setHovered.of(null) });
        return false;
      },
      touchstart(event, view) {
        cancel();
        const touch = event.touches[0];
        if (event.touches.length !== 1 || !touch) return false;
        const { clientX: x, clientY: y } = touch;
        press = {
          x,
          y,
          timer: setTimeout(() => {
            press = null;
            const position = view.posAtCoords({ x, y });
            if (position !== null) onComment(lineAt(view, position));
          }, LONG_PRESS_MS),
        };
        return false;
      },
      touchmove(event) {
        const touch = event.touches[0];
        if (
          press &&
          touch &&
          Math.hypot(touch.clientX - press.x, touch.clientY - press.y) > MOVE_TOLERANCE_PX
        ) {
          cancel();
        }
        return false;
      },
      touchend: () => {
        cancel();
        return false;
      },
      touchcancel: () => {
        cancel();
        return false;
      },
    }),
  ];
}
