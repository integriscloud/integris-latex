import type { ReactNode } from 'react';
import { Container } from '../container/Container';
import type { NavLink } from '../site-header/SiteHeader';
import styles from './site-footer.module.css';

export interface FooterColumn {
  title: string;
  links: readonly NavLink[];
}

export interface SiteFooterProps {
  /** The product logo (see Logo). */
  brand: ReactNode;
  tagline: string;
  columns: readonly FooterColumn[];
  /** Bottom line, e.g. copyright. */
  legal: string;
}

export function SiteFooter({ brand, tagline, columns, legal }: SiteFooterProps) {
  return (
    <footer className={styles.footer}>
      <Container>
        <div className={styles.top}>
          <div className={styles.about}>
            {brand}
            <p className={styles.tagline}>{tagline}</p>
          </div>
          {columns.map((column) => (
            <nav key={column.title} aria-label={column.title} className={styles.column}>
              <p className={styles.columnTitle}>{column.title}</p>
              <ul className={styles.links}>
                {column.links.map((link) => (
                  <li key={link.href}>
                    <a className={styles.link} href={link.href}>
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <p className={styles.legal}>{legal}</p>
      </Container>
    </footer>
  );
}
