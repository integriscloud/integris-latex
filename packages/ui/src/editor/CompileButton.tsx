'use client';

import { ChevronDown, CircleAlert, LoaderCircle, Play } from 'lucide-react';
import { type ReactNode, useCallback, useId, useRef, useState } from 'react';
import styles from './compile-button.module.css';
import panel from './menu-panel.module.css';
import { useDismiss } from './use-dismiss';

/**
 * idle: nothing to do · changed: the code changed since the last compilation (amber dot) ·
 * queued: waiting in the queue · running: compiling · failed: errors to read.
 */
export type CompileButtonState = 'idle' | 'changed' | 'queued' | 'running' | 'failed';

export interface CompileButtonProps {
  state: CompileButtonState;
  /** "Compiler", "3e dans la file", "Compilation… 8 s", "2 erreurs". */
  label: string;
  /** Accessible name of the main button when the label is a status ("Compiler"). */
  actionLabel: string;
  onCompile: () => void;
  disabled?: boolean;
  /** Accessible name of the menu button. */
  menuLabel: string;
  /** Content of the menu (engine, automatic compilation). */
  menu: ReactNode;
}

/**
 * Split button of the editor (design system, "Bouton de compilation"): the action with its state,
 * and a menu of compilation settings. The state is announced to screen readers.
 */
export function CompileButton({
  state,
  label,
  actionLabel,
  onCompile,
  disabled = false,
  menuLabel,
  menu,
}: CompileButtonProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const close = useCallback(() => setOpen(false), []);

  useDismiss(root, open, close);

  const Icon =
    state === 'running' || state === 'queued'
      ? LoaderCircle
      : state === 'failed'
        ? CircleAlert
        : Play;
  return (
    <div ref={root} className={`${styles.group} ${styles[state]}`}>
      <button
        type="button"
        className={styles.main}
        onClick={onCompile}
        disabled={disabled}
        // The text is hidden on phones: the name always says the action and the state.
        aria-label={label === actionLabel ? actionLabel : `${actionLabel} (${label})`}
        title={label}
      >
        <span className={styles.dot} aria-hidden="true" />
        <Icon
          className={`${styles.icon} ${state === 'running' ? styles.spin : ''}`}
          size={18}
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <span className={styles.label} aria-live="polite">
          {label}
        </span>
      </button>
      <button
        type="button"
        className={styles.toggle}
        aria-label={menuLabel}
        title={menuLabel}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDown size={16} strokeWidth={2} aria-hidden="true" />
      </button>
      <div id={panelId} className={panel.menu} hidden={!open}>
        {menu}
      </div>
    </div>
  );
}
