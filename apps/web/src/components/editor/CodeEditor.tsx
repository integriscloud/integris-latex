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
import { type CommentMark, commentMarks, setCommentMarks } from '../../lib/editor/comment-marks';
import { latexFolding } from '../../lib/editor/folding';
import { type LineSelection, lineComments } from '../../lib/editor/line-comment';
import { codeHighlight, languageFor, textKindOf } from '../../lib/editor/language';
import { editorTheme } from '../../lib/editor/theme';
import styles from './editor.module.css';

export interface CodeEditorHandle {
  /** Moves the cursor to a line of the open file and scrolls it into view. */
  goTo: (line: number, column?: number) => void;
  openSearch: () => void;
  /** Line of the cursor in the open file (SyncTeX, "show in the PDF"). */
  cursorLine: () => number | null;
  /** The selected text of the open file (to comment it), or null without selection. */
  selection: () => { from: number; to: number; text: string } | null;
  /** Selects a range of the open file and scrolls it into view (a comment's text). */
  select: (from: number, to: number) => void;
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
  /** Read-only text that can still be selected with the keyboard (to comment it). */
  selectable?: boolean;
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
  /** Commented selections of the open file. */
  marks?: readonly CommentMark[];
  /** A click on commented text. */
  onMarkClick?: (id: string) => void;
  /**
   * Comment a whole line in one click ("+" in the margin, long press on phones): given to the
   * roles that comment. Null for an empty line.
   */
  onCommentLine?: (line: LineSelection | null) => void;
  /** Accessible name of the "+" of a line ("Commenter la ligne 12"). */
  commentLineLabel?: (line: number) => string;
}

/**
 * Read-only state. A text that is commented stays focusable (keyboard selection), still refusing
 * every change, without opening the virtual keyboard of phones.
 */
const readOnlyState = (readOnly: boolean, selectable: boolean) => [
  EditorState.readOnly.of(readOnly),
  EditorView.editable.of(!readOnly || selectable),
  readOnly && selectable ? EditorView.contentAttributes.of({ inputmode: 'none' }) : [],
];

const spellcheckAttribute = (on: boolean) =>
  EditorView.contentAttributes.of({ spellcheck: on ? 'true' : 'false' });

/**
 * CodeMirror 6 editor bound to the shared text of a file (y-codemirror): changes of the others
 * and their cursors appear live; undo only undoes one's own changes. One editor view; switching
 * files rebuilds the state from the shared text and puts the cursor back where it was.
 */
export function CodeEditor(props: CodeEditorProps) {
  const { ref, fileId, path, shared, readOnly, spellcheck, marks, selectable = false } = props;
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const selections = useRef(new Map<string, EditorSelection>());
  const current = useRef<string | null>(null);
  const readOnlyCompartment = useRef(new Compartment());
  const languageCompartment = useRef(new Compartment());
  const spellcheckCompartment = useRef(new Compartment());
  const lineCommentCompartment = useRef(new Compartment());
  const canCommentLines = Boolean(props.onCommentLine);
  const lineCommentExtension = (on: boolean) =>
    on
      ? lineComments(
          (line) => latest.current.commentLineLabel?.(line) ?? String(line),
          (line) => latest.current.onCommentLine?.(line),
        )
      : [];
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
      readOnlyCompartment.current.of(
        readOnlyState(latest.current.readOnly, latest.current.selectable ?? false),
      ),
      languageCompartment.current.of([]),
      commentMarks((id) => latest.current.onMarkClick?.(id)),
      lineCommentCompartment.current.of(
        lineCommentExtension(Boolean(latest.current.onCommentLine)),
      ),
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
      effects: readOnlyCompartment.current.reconfigure(readOnlyState(readOnly, selectable)),
    });
  }, [readOnly, selectable, fileId]);

  // The "+" of the lines follows the right to comment (a role can change while open).
  useEffect(() => {
    view.current?.dispatch({
      effects: lineCommentCompartment.current.reconfigure(lineCommentExtension(canCommentLines)),
    });
  }, [canCommentLines, fileId]);

  // Comments of the file, placed by their anchors in the shared text.
  useEffect(() => {
    view.current?.dispatch({ effects: setCommentMarks.of(marks ?? []) });
  }, [marks, fileId]);

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
      selection() {
        const editor = view.current;
        const range = editor?.state.selection.main;
        if (!editor || !range || range.empty) return null;
        return {
          from: range.from,
          to: range.to,
          text: editor.state.sliceDoc(range.from, range.to),
        };
      },
      select(from, to) {
        const editor = view.current;
        if (!editor) return;
        const length = editor.state.doc.length;
        editor.dispatch({
          selection: EditorSelection.range(Math.min(from, length), Math.min(to, length)),
          effects: EditorView.scrollIntoView(Math.min(from, length), { y: 'center' }),
        });
        editor.focus();
      },
    }),
    [],
  );

  return <div ref={host} className={styles.code} />;
}
