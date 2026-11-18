'use client';

import type { LucideIcon } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import styles from './editor-layout.module.css';
import {
  clampWidths,
  DEFAULT_WIDTHS,
  type PaneWidths,
  parseWidths,
  WIDTH_LIMITS,
  WIDTHS_STORAGE_KEY,
} from './pane-widths';
import { ResizeHandle } from './ResizeHandle';

export type EditorPane = 'files' | 'code' | 'pdf' | 'side';

function readWidths(): PaneWidths {
  try {
    return parseWidths(window.localStorage.getItem(WIDTHS_STORAGE_KEY));
  } catch {
    // Storage unavailable (private window, blocked site data): default widths.
    return DEFAULT_WIDTHS;
  }
}

/** Arrow keys move a splitter by this share of the workspace (or px for the comments pane). */
const KEY_STEP = { files: 2, pdf: 2, side: 16 } as const;

export interface EditorPaneTab {
  pane: EditorPane;
  label: string;
  icon: LucideIcon;
  /** Small count shown on the tab (comments…). */
  count?: number;
}

export interface EditorLayoutProps {
  /** Link back to the project. */
  back: ReactNode;
  title: string;
  /** Under the title: path of the open file, read-only badge. */
  subtitle?: ReactNode;
  /** Save status, always visible. */
  status: ReactNode;
  /** Place of the collaborators online (real-time collaboration, later step). */
  presence?: ReactNode;
  /** Compile button and the toggles of the panes. */
  actions?: ReactNode;
  /** Message between the bar and the panes (mobile notice, offline…). */
  notice?: ReactNode;
  files: ReactNode;
  code: ReactNode;
  pdf: ReactNode;
  side: ReactNode;
  /** The four panes in tab order, for the bottom tabs of phones. */
  tabs: readonly EditorPaneTab[];
  /** Pane shown on narrow screens (one pane at a time below 960 px). */
  view: EditorPane;
  onViewChange: (pane: EditorPane) => void;
  /** Comments and submissions pane open on wide screens. */
  sideOpen: boolean;
  labels: {
    tabs: string;
    resizeFiles: string;
    resizePdf: string;
    resizeSide: string;
  };
}

/**
 * Editor screen (no mockup yet; built from the design system): a bar, then files | code | PDF |
 * comments and submissions, resizable on wide screens (breakpoints 960 and 1280), one pane at a
 * time with bottom tabs on phones and tablets.
 */
export function EditorLayout({
  back,
  title,
  subtitle,
  status,
  presence,
  actions,
  notice,
  files,
  code,
  pdf,
  side,
  tabs,
  view,
  onViewChange,
  sideOpen,
  labels,
}: EditorLayoutProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  // Client-only screen (the editor is not rendered on the server): stored widths at once.
  const [widths, setWidths] = useState<PaneWidths>(() =>
    typeof window === 'undefined' ? DEFAULT_WIDTHS : readWidths(),
  );

  // Dynamic widths chosen by the user: CSS variables on the root, read by the stylesheet.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.style.setProperty('--editor-files', `${widths.files}%`);
    root.style.setProperty('--editor-pdf', `${widths.pdf}%`);
    root.style.setProperty('--editor-side', `${widths.side}px`);
  }, [widths]);

  /** Moves a splitter: `delta` in px for a drag, or in keyboard steps. */
  const resize = useCallback((pane: keyof PaneWidths, delta: number, unit: 'px' | 'step') => {
    const total = workspaceRef.current?.clientWidth || window.innerWidth;
    const change =
      unit === 'step' ? delta * KEY_STEP[pane] : pane === 'side' ? delta : (delta / total) * 100;
    setWidths((current) => {
      const next = clampWidths({ ...current, [pane]: current[pane] + change }, pane);
      try {
        window.localStorage.setItem(WIDTHS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Not remembered: the panes keep their width until the page is left.
      }
      return next;
    });
  }, []);

  const pane = (
    id: EditorPane,
    label: string,
    content: ReactNode,
    Tag: 'section' | 'aside' = 'section',
  ) => (
    <Tag className={styles.pane} data-pane={id} id={`editor-pane-${id}`} aria-label={label}>
      {content}
    </Tag>
  );
  const labelOf = (id: EditorPane) => tabs.find((tab) => tab.pane === id)?.label ?? id;

  return (
    <div ref={rootRef} className={styles.root} data-view={view} data-side={sideOpen}>
      <header className={styles.bar}>
        <div className={styles.back}>{back}</div>
        <div className={styles.heading}>
          <h1 className={styles.title}>{title}</h1>
          {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
        </div>
        <div className={styles.status}>{status}</div>
        {presence && <div className={styles.presence}>{presence}</div>}
        {actions && <div className={styles.actions}>{actions}</div>}
      </header>
      {notice && <div className={styles.notice}>{notice}</div>}
      <div ref={workspaceRef} className={styles.workspace}>
        {pane('files', labelOf('files'), files)}
        <ResizeHandle
          className={styles.handleFiles}
          label={labels.resizeFiles}
          value={widths.files}
          min={WIDTH_LIMITS.files[0]}
          max={WIDTH_LIMITS.files[1]}
          unit="%"
          onResize={(delta, unit) => resize('files', delta, unit)}
        />
        {pane('code', labelOf('code'), code)}
        <ResizeHandle
          className={styles.handlePdf}
          label={labels.resizePdf}
          value={widths.pdf}
          min={WIDTH_LIMITS.pdf[0]}
          max={WIDTH_LIMITS.pdf[1]}
          unit="%"
          // Dragging to the left widens the PDF.
          onResize={(delta, unit) => resize('pdf', -delta, unit)}
        />
        {pane('pdf', labelOf('pdf'), pdf)}
        <ResizeHandle
          className={styles.handleSide}
          label={labels.resizeSide}
          value={widths.side}
          min={WIDTH_LIMITS.side[0]}
          max={WIDTH_LIMITS.side[1]}
          unit="px"
          onResize={(delta, unit) => resize('side', -delta, unit)}
        />
        {pane('side', labelOf('side'), side, 'aside')}
      </div>
      <nav className={styles.tabs} aria-label={labels.tabs}>
        {tabs.map(({ pane: id, label, icon: Icon, count }) => (
          <button
            key={id}
            type="button"
            className={styles.tab}
            aria-current={view === id ? 'page' : undefined}
            aria-controls={`editor-pane-${id}`}
            onClick={() => onViewChange(id)}
          >
            <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
            <span>{label}</span>
            {count !== undefined && count > 0 && <span className={styles.count}>{count}</span>}
          </button>
        ))}
      </nav>
    </div>
  );
}
