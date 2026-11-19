import { EditorView } from '@codemirror/view';

/** Editor look from the design tokens: JetBrains Mono 14/1.7, tabular line numbers. */
export const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--surface)',
    color: 'var(--texte)',
    font: 'var(--t-code)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-code)',
    lineHeight: '1.7',
    fontVariantLigatures: 'none',
  },
  '.cm-content': { padding: 'var(--espace-2) 0', caretColor: 'var(--action)' },
  '.cm-line': { padding: '0 var(--espace-4) 0 var(--espace-2)' },
  '.cm-gutters': {
    backgroundColor: 'var(--surface)',
    color: 'var(--neutre-400)',
    border: 'none',
    fontVariantNumeric: 'tabular-nums',
  },
  '.cm-activeLineGutter': { backgroundColor: 'var(--surface-creuse)', color: 'var(--texte-2)' },
  '.cm-activeLine': {
    backgroundColor: 'color-mix(in srgb, var(--surface-creuse) 60%, transparent)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--action)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'var(--toge-100)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--or-50)' },
  // "+" in the margin of the line under the pointer: comment the whole line.
  '.cm-commentGutter': { width: '24px' },
  '.cm-commentGutter .cm-gutterElement': { display: 'flex', alignItems: 'center' },
  '.cm-commentLine': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '22px',
    height: '22px',
    padding: '0',
    border: 'none',
    borderRadius: 'var(--r-sm)',
    background: 'var(--action-doux)',
    color: 'var(--action)',
    cursor: 'pointer',
  },
  '.cm-commentLine:hover': { background: 'var(--toge-100)' },
  '.cm-commentLine:focus-visible': { outline: '2px solid var(--action)', outlineOffset: '1px' },
  // Commented text: gold underline, stronger for the comment shown in the panel.
  '.cm-comment': {
    backgroundColor: 'var(--or-50)',
    borderBottom: '2px solid var(--or-300)',
    cursor: 'pointer',
  },
  '.cm-comment-active': {
    backgroundColor: 'var(--or-100)',
    borderBottomColor: 'var(--accent)',
  },
  '.cm-searchMatch': { backgroundColor: 'var(--or-100)', outline: '1px solid var(--or-300)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--or-200)' },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--toge-50)',
    outline: '1px solid var(--toge-200)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--surface-creuse)',
    border: '1px solid var(--bordure-forte)',
    color: 'var(--texte-3)',
    borderRadius: 'var(--r-sm)',
    padding: '0 var(--espace-1)',
  },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 var(--espace-1)', cursor: 'pointer' },
  '.cm-panels': {
    backgroundColor: 'var(--surface-creuse)',
    color: 'var(--texte)',
    font: 'var(--t-texte-sm)',
  },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--bordure)' },
  '.cm-panel.cm-search': { padding: 'var(--espace-2) var(--espace-3)' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': {
    font: 'var(--t-texte-sm)',
    minHeight: '36px',
    margin: '2px var(--espace-1) 2px 0',
  },
  '.cm-textfield': {
    border: '1px solid var(--bordure-forte)',
    borderRadius: 'var(--r-md)',
    backgroundColor: 'var(--surface)',
    padding: '0 var(--espace-2)',
  },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'var(--surface)',
    border: '1px solid var(--bordure-forte)',
    borderRadius: 'var(--r-md)',
    color: 'var(--texte)',
    padding: '0 var(--espace-3)',
  },
  '.cm-panel.cm-search [name=close]': {
    minHeight: 'auto',
    fontSize: '20px',
    color: 'var(--texte-3)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface)',
    border: '1px solid var(--bordure)',
    borderRadius: 'var(--r-md)',
    boxShadow: 'var(--ombre-2)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { font: 'var(--t-code)', maxHeight: '18em' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '2px var(--espace-2)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--action)',
    color: 'var(--neutre-0)',
  },
  '.cm-completionDetail': {
    marginLeft: 'var(--espace-3)',
    fontFamily: 'var(--font-ui)',
    fontStyle: 'normal',
    fontSize: '12px',
    opacity: '0.8',
  },
  // Cursors of the others: the name always shows above the cursor, in the person's color
  // (y-codemirror only shows it on hover). It never takes the clicks meant for the text.
  '.cm-ySelectionInfo': {
    opacity: '1',
    transition: 'none',
    top: '-1.35em',
    font: 'var(--t-legende)',
    color: 'var(--neutre-0)',
    padding: '0 var(--espace-1)',
    borderRadius: 'var(--r-sm) var(--r-sm) var(--r-sm) 0',
    pointerEvents: 'none',
  },
  '.cm-ySelectionCaret:hover > .cm-ySelectionCaretDot': { transform: 'none' },
});
