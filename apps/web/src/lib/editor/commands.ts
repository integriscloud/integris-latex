import { toggleComment } from '@codemirror/commands';
import { EditorSelection, type Extension } from '@codemirror/state';
import { type Command, keymap } from '@codemirror/view';

/** Wraps each selection in `\command{…}`; with no selection, inserts it with the cursor inside. */
export function wrapWith(command: string): Command {
  return (view) => {
    if (view.state.readOnly) return false;
    const open = `\\${command}{`;
    view.dispatch(
      view.state.changeByRange((range) => ({
        changes: [
          { from: range.from, insert: open },
          { from: range.to, insert: '}' },
        ],
        range: range.empty
          ? EditorSelection.cursor(range.from + open.length)
          : EditorSelection.range(range.from + open.length, range.to + open.length),
      })),
      { scrollIntoView: true, userEvent: 'input' },
    );
    return true;
  };
}

/**
 * Shortcuts of docs/spec.md: bold, italic, comment (LaTeX files), compile (Ctrl+S or Ctrl+Enter;
 * compiling saves first).
 */
export function editorShortcuts({
  latex,
  compile,
}: {
  latex: boolean;
  compile: () => void;
}): Extension {
  const run = () => {
    compile();
    return true;
  };
  return keymap.of([
    { key: 'Mod-s', preventDefault: true, run },
    { key: 'Mod-Enter', preventDefault: true, run },
    ...(latex
      ? [
          { key: 'Mod-b', run: wrapWith('textbf') },
          { key: 'Mod-i', run: wrapWith('textit') },
        ]
      : []),
    { key: 'Mod-/', run: toggleComment },
  ]);
}
