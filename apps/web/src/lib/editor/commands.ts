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

/** Shortcuts of docs/spec.md: bold, italic, comment (LaTeX files), save. */
export function editorShortcuts({ latex, save }: { latex: boolean; save: () => void }): Extension {
  return keymap.of([
    {
      key: 'Mod-s',
      preventDefault: true,
      run: () => {
        save();
        return true;
      },
    },
    ...(latex
      ? [
          { key: 'Mod-b', run: wrapWith('textbf') },
          { key: 'Mod-i', run: wrapWith('textit') },
        ]
      : []),
    { key: 'Mod-/', run: toggleComment },
  ]);
}
