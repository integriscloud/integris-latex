'use client';

import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import {
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
} from '@codemirror/search';
import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { editorShortcuts } from '../../lib/editor/commands';
import {
  type CompletionLabels,
  latexCompletion,
  type ProjectSymbols,
} from '../../lib/editor/completion';
import { latexFolding } from '../../lib/editor/folding';
import { codeHighlight, languageFor, textKindOf } from '../../lib/editor/language';
import { editorTheme } from '../../lib/editor/theme';
import styles from './editor.module.css';

export interface CodeEditorHandle {
  /** Moves the cursor to a line of the open file and scrolls it into view. */
  goTo: (line: number, column?: number) => void;
  openSearch: () => void;
  /** Line of the cursor in the open file (SyncTeX, "show in the PDF"). */
  cursorLine: () => number | null;
}

/** The shared text of a file and what goes with it (collaboration server). */
export interface SharedText {
  text: Y.Text;
  /** Cursors and selections of the others in this file. */
  awareness: Awareness;
  /** Undo and redo of one's own changes only. */
  undoManager: Y.UndoManager;
}

export interface CodeEditorProps {
  ref?: Ref<CodeEditorHandle>;
  fileId: string;
  path: string;
  shared: SharedText;
  readOnly: boolean;
  /** Browser spell checker in the code (editor settings, kept on the account). */
  spellcheck: boolean;
  /** Language of the interface: spell checking of the browser. */
  lang: string;
  label: string;
  phrases: Record<string, string>;
  completionLabels: CompletionLabels;
  symbols: () => ProjectSymbols;
  /** Files of the project read for \ref and \cite. */
  index: { ready: () => boolean; load: () => Promise<void> };
  /** Ctrl+S, Ctrl+Enter: save and compile. */
  onCompile: () => void;
}

const spellcheckAttribute = (on: boolean) =>
  EditorView.contentAttributes.of({ spellcheck: on ? 'true' : 'false' });

/**
 * CodeMirror 6 editor bound to the shared text of a file (y-codemirror): changes of the others
 * and their cursors appear live; undo only undoes one's own changes. One editor view; switching
 * files rebuilds the state from the shared text and puts the cursor back where it was.
 */
export function CodeEditor(props: CodeEditorProps) {
  const { ref, fileId, path, shared, readOnly, spellcheck } = props;
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const selections = useRef(new Map<string, EditorSelection>());
  const current = useRef<string | null>(null);
  const readOnlyCompartment = useRef(new Compartment());
  const languageCompartment = useRef(new Compartment());
  const spellcheckCompartment = useRef(new Compartment());
  // Callbacks change on every render; the extensions read the latest ones.
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });

  const createState = (filePath: string, text: SharedText): EditorState => {
    const kind = textKindOf(filePath);
    const latex = kind === 'latex';
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      foldGutter(),
      yCollab(text.text, text.awareness, { undoManager: text.undoManager }),
      drawSelection(),
      dropCursor(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      syntaxHighlighting(codeHighlight),
      EditorView.lineWrapping,
      editorTheme,
      EditorState.phrases.of(latest.current.phrases),
      // The browser's spell checker underlines every LaTeX command: off unless the user wants it.
      spellcheckCompartment.current.of(spellcheckAttribute(latest.current.spellcheck)),
      EditorView.contentAttributes.of({
        lang: latest.current.lang,
        autocapitalize: 'off',
        autocorrect: 'off',
        'aria-label': latest.current.label,
      }),
      editorShortcuts({ latex, compile: () => latest.current.onCompile() }),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...yUndoManagerKeymap,
        ...foldKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      readOnlyCompartment.current.of([
        EditorState.readOnly.of(latest.current.readOnly),
        EditorView.editable.of(!latest.current.readOnly),
      ]),
      languageCompartment.current.of([]),
    ];
    if (latex) {
      extensions.push(
        latexFolding,
        autocompletion({
          override: [
            latexCompletion(() => latest.current.symbols(), latest.current.completionLabels, {
              ready: () => latest.current.index.ready(),
              load: () => latest.current.index.load(),
            }),
          ],
          icons: false,
        }),
      );
    }
    const doc = text.text.toString();
    // The cursor goes back where it was, if the text still has that place.
    const kept = selections.current.get(fileId);
    const selection =
      kept && kept.ranges.every((range) => range.to <= doc.length) ? kept : undefined;
    return EditorState.create({ doc, selection, extensions });
  };

  // One view for the life of the component.
  useEffect(() => {
    const editor = new EditorView({ parent: host.current! });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
      current.current = null;
    };
  }, []);

  // Switch to the open file. A hidden file is not bound to its shared text (the others may have
  // changed it meanwhile): its state is rebuilt from it each time it is shown.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    if (current.current && current.current !== fileId) {
      selections.current.set(current.current, editor.state.selection);
    }
    if (current.current === fileId) return;
    current.current = fileId;
    editor.setState(createState(path, shared));
    const kind = textKindOf(path);
    void languageFor(kind).then((language) => {
      if (current.current === fileId && view.current) {
        view.current.dispatch({ effects: languageCompartment.current.reconfigure(language) });
      }
    });
  }, [fileId, path, shared]);

  // Rights can change (save refused, read-only project).
  useEffect(() => {
    view.current?.dispatch({
      effects: readOnlyCompartment.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly, fileId]);

  // The setting is changed from the editor menu; each file keeps its own state.
  useEffect(() => {
    view.current?.dispatch({
      effects: spellcheckCompartment.current.reconfigure(spellcheckAttribute(spellcheck)),
    });
  }, [spellcheck, fileId]);

  useImperativeHandle(
    ref,
    () => ({
      goTo(line, column = 1) {
        const editor = view.current;
        if (!editor) return;
        const target = editor.state.doc.line(Math.min(Math.max(line, 1), editor.state.doc.lines));
        const position = Math.min(target.from + column - 1, target.to);
        editor.dispatch({
          selection: EditorSelection.cursor(position),
          effects: EditorView.scrollIntoView(position, { y: 'center' }),
        });
        editor.focus();
      },
      openSearch() {
        if (view.current) openSearchPanel(view.current);
      },
      cursorLine() {
        const editor = view.current;
        return editor ? editor.state.doc.lineAt(editor.state.selection.main.head).number : null;
      },
    }),
    [],
  );

  return <div ref={host} className={styles.code} />;
}
