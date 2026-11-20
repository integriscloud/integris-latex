'use client';

import { Ellipsis, type LucideIcon } from 'lucide-react';
import { type KeyboardEvent, useId, useLayoutEffect, useRef } from 'react';
import { IconButton } from '../icon-button/IconButton';
import { useDismiss } from '../editor/use-dismiss';
import styles from './row-menu.module.css';

/** One action of a row of the file tree. */
export interface TreeMenuItem {
  id: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  tone?: 'danger';
  /** Folders: also shown as a button while the row is hovered or focused. */
  quick?: boolean;
  /** Accessible name of that button when the label alone is ambiguous ("… in chapters"). */
  quickLabel?: string;
}

export interface RowMenuProps {
  /** Accessible name of the "…" button, e.g. "Actions de chapitres". */
  label: string;
  items: readonly TreeMenuItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * "…" menu of a row: a real menu (arrow keys, Home, End, Escape), placed under its button above
 * the scrolling panes, following it when they scroll. Closed by a click outside, Escape or Tab.
 */
export function RowMenu({ label, items, open, onOpenChange }: RowMenuProps) {
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const close = () => onOpenChange(false);
  useDismiss(root, open, close);

  // Placed under its button (fixed: the tree scrolls inside a pane), and kept there while the
  // page or the pane scrolls; the first item takes the focus.
  useLayoutEffect(() => {
    if (!open || !button.current || !list.current) return;
    const anchor = button.current;
    const menu = list.current;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom;
      const height = menu.offsetHeight;
      const top =
        below < height + 8 && rect.top > height + 8 ? rect.top - height - 4 : rect.bottom + 4;
      menu.style.setProperty('--menu-top', `${Math.max(8, top)}px`);
      menu.style.setProperty('--menu-right', `${Math.max(8, window.innerWidth - rect.right)}px`);
    };
    place();
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  const keyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')].filter(
      (item) => !item.disabled,
    );
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const focus = (next: number) =>
      buttons[(next + buttons.length) % buttons.length]?.focus({ preventScroll: true });
    if (event.key === 'ArrowDown') focus(index + 1);
    else if (event.key === 'ArrowUp') focus(index - 1);
    else if (event.key === 'Home') focus(0);
    else if (event.key === 'End') focus(buttons.length - 1);
    else if (event.key === 'Escape') {
      close();
      button.current?.focus();
    } else if (event.key === 'Tab') {
      close();
      return;
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <span ref={root} className={styles.root}>
      <IconButton
        ref={button}
        icon={Ellipsis}
        label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => onOpenChange(!open)}
      />
      {open && (
        <ul
          ref={list}
          id={id}
          role="menu"
          aria-label={label}
          className={styles.menu}
          onKeyDown={keyDown}
        >
          {items.map((item) => (
            <li key={item.id} role="none">
              <button
                type="button"
                role="menuitem"
                className={styles.item}
                data-tone={item.tone}
                disabled={item.disabled}
                onClick={() => {
                  close();
                  // Focus back on "…": a dialog opened by the action returns there when closed.
                  button.current?.focus();
                  item.onSelect();
                }}
              >
                <item.icon size={18} strokeWidth={1.75} aria-hidden="true" />
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
