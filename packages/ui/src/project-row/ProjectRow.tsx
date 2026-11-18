import type { ReactNode } from 'react';
import styles from './project-row.module.css';

export interface ProjectRowProps {
  name: string;
  /** Link of the name; omitted for a project that cannot be opened (trash). */
  href?: string;
  /** Second line: type, owner, last change. */
  meta: string;
  /** People column: owner or sharing state. */
  people?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
}

/** One project in a list (mockup etudiant-01, "Mes documents"). */
export function ProjectRow({ name, href, meta, people, badge, actions }: ProjectRowProps) {
  return (
    <li className={styles.row}>
      <span className={styles.thumb} aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className={styles.text}>
        {href ? (
          <a className={styles.name} href={href}>
            {name}
          </a>
        ) : (
          <span className={styles.name}>{name}</span>
        )}
        <span className={styles.meta}>{meta}</span>
      </span>
      {people && <span className={styles.people}>{people}</span>}
      {badge && <span className={styles.badge}>{badge}</span>}
      {actions && <span className={styles.actions}>{actions}</span>}
    </li>
  );
}

/** List of project rows inside a card. */
export function ProjectList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul className={styles.list} aria-label={label}>
      {children}
    </ul>
  );
}
