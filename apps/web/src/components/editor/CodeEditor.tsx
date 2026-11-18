'use client';

import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
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
  /** Replaces the whole text of a file (conflict resolved, replace in the project). */
  setText: (fileId: string, text: string) => void;
  /** Moves the cursor to a line of the open file and scrolls it into view. */
  goTo: (line: number, column?: number) => void;
  openSearch: () => void;
  /** Forgets the state of a file (closed, deleted). */
  forget: (fileId: string) => void;
}

export interface CodeEditorProps {
  ref?: Ref<CodeEditorHandle>;
  fileId: string;
  path: string;
  /** Text of the file when it is first shown (later, its own state is kept). */
  initialText: string;
  readOnly: boolean;
  /** Language of the interface: spell checking of the browser. */
  lang: string;
  label: string;
  phrases: Record<string, string>;
  completionLabels: CompletionLabels;
  symbols: () => ProjectSymbols;
  /** Files of the project read for \ref and \cite. */
  index: { ready: () => boolean; load: () => Promise<void> };
  onChange: (fileId: string, text: string) => void;
  onSave: () => void;
}

/**
 * CodeMirror 6 editor. One editor view; each open file keeps its own state (text, undo history,
 * selection, folds) while the user switches between files.
 */
export function CodeEditor(props: CodeEditorProps) {
  const { ref, fileId, path, initialText, readOnly } = props;
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const states = useRef(new Map<string, EditorState>());
  const current = useRef<string | null>(null);
  const readOnlyCompartment = useRef(new Compartment());
  const languageCompartment = useRef(new Compartment());
  // Callbacks change on every render; the extensions read the latest ones.
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });

  const createState = (id: string, filePath: string, text: string): EditorState => {
    const kind = textKindOf(filePath);
    const latex = kind === 'latex';
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      foldGutter(),
      history(),
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
      EditorView.contentAttributes.of({
        spellcheck: 'true',
        lang: latest.current.lang,
        autocapitalize: 'off',
        autocorrect: 'off',
        'aria-label': latest.current.label,
      }),
      editorShortcuts({ latex, save: () => latest.current.onSave() }),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      readOnlyCompartment.current.of([
        EditorState.readOnly.of(latest.current.readOnly),
        EditorView.editable.of(!latest.current.readOnly),
      ]),
      languageCompartment.current.of([]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && current.current === id) {
          latest.current.onChange(id, update.state.doc.toString());
        }
      }),
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
    return EditorState.create({ doc: text, extensions });
  };

  // One view for the life of the component.
  useEffect(() => {
    const editor = new EditorView({ parent: host.current! });
    view.current = editor;
    const cache = states.current;
    return () => {
      editor.destroy();
      view.current = null;
      cache.clear();
      current.current = null;
    };
  }, []);

  // Switch to the open file: keep the state of the previous one, restore or create this one.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    if (current.current && current.current !== fileId) {
      states.current.set(current.current, editor.state);
    }
    if (current.current === fileId) return;
    current.current = fileId;
    const state = states.current.get(fileId) ?? createState(fileId, path, initialText);
    editor.setState(state);
    const kind = textKindOf(path);
    void languageFor(kind).then((language) => {
      if (current.current === fileId && view.current) {
        view.current.dispatch({ effects: languageCompartment.current.reconfigure(language) });
      }
    });
  }, [fileId, path, initialText]);

  // Rights can change (save refused, read-only project).
  useEffect(() => {
    view.current?.dispatch({
      effects: readOnlyCompartment.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly, fileId]);

  useImperativeHandle(
    ref,
    () => ({
      setText(id, text) {
        const editor = view.current;
        if (editor && current.current === id) {
          editor.dispatch({
            changes: { from: 0, to: editor.state.doc.length, insert: text },
            userEvent: 'input.replace',
          });
          return;
        }
        const state = states.current.get(id);
        if (state) {
          states.current.set(
            id,
            state.update({ changes: { from: 0, to: state.doc.length, insert: text } }).state,
          );
        }
      },
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
      forget(id) {
        states.current.delete(id);
      },
    }),
    [],
  );

  return <div ref={host} className={styles.code} />;
}
