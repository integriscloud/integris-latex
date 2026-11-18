'use client';

import { ChevronsUpDown, Menu, X } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import styles from './app-shell.module.css';

export interface AppNavItem {
  href: string;
  label: string;
  /** Rendered icon (24 px grid, stroke 1.75): an element, so a server component can pass it. */
  icon: ReactNode;
  current?: boolean;
}

export type SpaceTone = 'personal' | 'student' | 'teacher' | 'secretary' | 'admin';

export interface AppSpace {
  title: string;
  subtitle: string;
  tone: SpaceTone;
  /** Link to "Choisir son espace" when the user has several spaces. */
  href?: string;
  /** Accessible hint of the link, e.g. "Changer d'espace". */
  switchLabel?: string;
}

export interface AppShellProps {
  brand: ReactNode;
  space: AppSpace;
  /** Accessible name of the side navigation. */
  navLabel: string;
  items: readonly AppNavItem[];
  /** Bottom of the side menu: the signed-in user. */
  footer?: ReactNode;
  /** Right side of the top bar (language, account). */
  topBar?: ReactNode;
  openMenuLabel: string;
  closeMenuLabel: string;
  children: ReactNode;
}

function SpaceSwitch({ space }: { space: AppSpace }) {
  const content = (
    <>
      <span className={`${styles.dot} ${styles[space.tone]}`} aria-hidden="true" />
      <span className={styles.spaceText}>
        <span className={styles.spaceTitle}>{space.title}</span>
        <span className={styles.spaceSubtitle}>{space.subtitle}</span>
      </span>
      {space.href && <ChevronsUpDown size={16} strokeWidth={1.75} aria-hidden="true" />}
    </>
  );
  return space.href ? (
    <a className={styles.space} href={space.href} title={space.switchLabel}>
      {content}
      {space.switchLabel && <span className={styles.srOnly}>{space.switchLabel}</span>}
    </a>
  ) : (
    <div className={styles.space}>{content}</div>
  );
}

/**
 * Application frame: dark side menu (space, navigation, user) and a light top bar. Below 960 px
 * the menu is hidden and opens over the content.
 */
export function AppShell({
  brand,
  space,
  navLabel,
  items,
  footer,
  topBar,
  openMenuLabel,
  closeMenuLabel,
  children,
}: AppShellProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className={styles.shell}>
      <nav
        id="app-menu"
        aria-label={navLabel}
        className={[styles.side, open && styles.open].filter(Boolean).join(' ')}
      >
        <div className={styles.sideHead}>
          {brand}
          <button
            type="button"
            className={styles.close}
            aria-label={closeMenuLabel}
            onClick={() => setOpen(false)}
          >
            <X size={24} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
        <SpaceSwitch space={space} />
        <ul className={styles.items}>
          {items.map(({ href, label, icon, current }) => (
            <li key={href}>
              <a
                className={styles.item}
                href={href}
                aria-current={current ? 'page' : undefined}
                onClick={() => setOpen(false)}
              >
                {icon}
                {label}
              </a>
            </li>
          ))}
        </ul>
        {footer && <div className={styles.footer}>{footer}</div>}
      </nav>
      {open && (
        <div className={styles.backdrop} aria-hidden="true" onClick={() => setOpen(false)} />
      )}
      <div className={styles.body}>
        <header className={styles.top}>
          <button
            type="button"
            className={styles.menu}
            aria-label={openMenuLabel}
            aria-expanded={open}
            aria-controls="app-menu"
            onClick={() => setOpen(true)}
          >
            <Menu size={24} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <div className={styles.topEnd}>{topBar}</div>
        </header>
        <main className={styles.main}>{children}</main>
      </div>
    </div>
  );
}

/** Signed-in user at the bottom of the side menu. */
export function AppUser({
  name,
  detail,
  action,
}: {
  name: string;
  detail?: string;
  action?: ReactNode;
}) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');
  return (
    <div className={styles.user}>
      <span className={styles.avatar} aria-hidden="true">
        {initials}
      </span>
      <span className={styles.userText}>
        <span className={styles.userName}>{name}</span>
        {detail && <span className={styles.userDetail}>{detail}</span>}
      </span>
      {action}
    </div>
  );
}
