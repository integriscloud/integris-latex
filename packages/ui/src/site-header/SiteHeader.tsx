import { Menu } from 'lucide-react';
import type { ReactNode } from 'react';
import { Container } from '../container/Container';
import styles from './site-header.module.css';

export interface NavLink {
  href: string;
  label: string;
}

export interface SiteHeaderProps {
  /** The product logo (see Logo). */
  brand: ReactNode;
  /** Accessible name of the main navigation. */
  navLabel: string;
  links: readonly NavLink[];
  /** Accessible name of the menu button shown on small screens. */
  menuLabel: string;
  /**
   * Main actions (e.g. sign up): in the bar from 600 px, inside the menu below.
   * The navigation links join the bar from 960 px.
   */
  actions: ReactNode;
  /** Secondary actions (e.g. log in, language): in the bar from 1280 px, inside the menu below. */
  secondaryActions?: ReactNode;
}

export function SiteHeader({
  brand,
  navLabel,
  links,
  menuLabel,
  actions,
  secondaryActions,
}: SiteHeaderProps) {
  const linkList = (
    <ul className={styles.links}>
      {links.map((link) => (
        <li key={link.href}>
          <a className={styles.link} href={link.href}>
            {link.label}
          </a>
        </li>
      ))}
    </ul>
  );

  return (
    <header className={styles.header}>
      <Container className={styles.bar}>
        {brand}
        <nav aria-label={navLabel} className={styles.nav}>
          {linkList}
        </nav>
        <div className={styles.actions}>
          {secondaryActions && <div className={styles.secondary}>{secondaryActions}</div>}
          <div className={styles.primary}>{actions}</div>
          <details className={styles.menu}>
            <summary className={styles.menuButton} aria-label={menuLabel}>
              <Menu size={24} strokeWidth={1.75} aria-hidden="true" />
            </summary>
            <div className={styles.panel}>
              <nav aria-label={navLabel} className={styles.panelNav}>
                {linkList}
              </nav>
              {secondaryActions && <div className={styles.panelActions}>{secondaryActions}</div>}
              <div className={`${styles.panelActions} ${styles.panelPrimary}`}>{actions}</div>
            </div>
          </details>
        </div>
      </Container>
    </header>
  );
}
