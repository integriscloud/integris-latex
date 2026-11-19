import type { ReactNode } from 'react';
import styles from './issue-card.module.css';

export interface IssueCardProps {
  severity: 'error' | 'warning';
  title: string;
  /** "chapitre2.tex · ligne 42": a button that opens the file at that line. */
  location?: { label: string; onOpen: () => void };
  children: ReactNode;
}

/** A compilation error or warning, translated (design system, "Erreurs de compilation"). */
export function IssueCard({ severity, title, location, children }: IssueCardProps) {
  return (
    <article className={`${styles.card} ${styles[severity]}`}>
      <header className={styles.head}>
        <h3 className={styles.title}>{title}</h3>
        {location && (
          <button type="button" className={styles.location} onClick={location.onOpen}>
            {location.label}
          </button>
        )}
      </header>
      <div className={styles.text}>{children}</div>
    </article>
  );
}
