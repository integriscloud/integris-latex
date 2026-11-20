'use client';

import type { LucideIcon } from 'lucide-react';
import { type ReactNode, useCallback, useId, useRef, useState } from 'react';
import { IconButton } from '../icon-button/IconButton';
import styles from './menu-button.module.css';
import panel from './menu-panel.module.css';
import { useDismiss } from './use-dismiss';

export interface MenuButtonProps {
  icon: LucideIcon;
  /** Accessible name of the button, also its tooltip ("Réglages de l'éditeur"). */
  label: string;
  /** Content of the menu: settings with their labels. */
  children: ReactNode;
  className?: string;
  /** Called when the panel opens (content computed on demand, e.g. the word count). */
  onOpen?: () => void;
}

/** Icon button of the editor's top bar that opens a panel of settings. */
export function MenuButton({ icon, label, children, className, onOpen }: MenuButtonProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(root, open, close);

  return (
    <div ref={root} className={[styles.root, className].filter(Boolean).join(' ')}>
      <IconButton
        icon={icon}
        label={label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen(!open);
        }}
      />
      <div id={panelId} className={panel.menu} hidden={!open}>
        {children}
      </div>
    </div>
  );
}
