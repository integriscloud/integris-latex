'use client';

import type { LucideIcon } from 'lucide-react';
import { type KeyboardEvent, useRef } from 'react';
import styles from './tabs.module.css';

export interface TabItem {
  id: string;
  label: string;
  icon?: LucideIcon;
}

export interface TabsProps {
  /** Accessible name of the tab list. */
  label: string;
  items: readonly TabItem[];
  value: string;
  onChange: (id: string) => void;
  /** Prefix of the tab and panel ids: tabs are `${idPrefix}-tab-${id}`, panels `${idPrefix}-panel-${id}`. */
  idPrefix: string;
}

/** Segmented tabs (WAI-ARIA tabs pattern, arrow keys move between tabs). */
export function Tabs({ label, items, value, onChange, idPrefix }: TabsProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (index: number, event: KeyboardEvent) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + items.length) % items.length;
    onChange(items[next]!.id);
    refs.current[next]?.focus();
  };

  return (
    <div className={styles.list} role="tablist" aria-label={label}>
      {items.map((item, index) => {
        const selected = item.id === value;
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${item.id}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${item.id}`}
            tabIndex={selected ? 0 : -1}
            className={styles.tab}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => onKeyDown(index, event)}
          >
            {Icon && <Icon size={16} strokeWidth={1.75} aria-hidden="true" />}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
