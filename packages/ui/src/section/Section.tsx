import type { ReactNode } from 'react';
import { Container } from '../container/Container';
import styles from './section.module.css';

export interface SectionProps {
  id?: string;
  eyebrow?: string;
  title: string;
  intro?: ReactNode;
  /** `muted` uses the sunken surface, to separate consecutive sections. */
  tone?: 'default' | 'muted';
  children: ReactNode;
}

/** A page section with an optional eyebrow, an h2 and an introduction. */
export function Section({ id, eyebrow, title, intro, tone = 'default', children }: SectionProps) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={[styles.section, tone === 'muted' && styles.muted].filter(Boolean).join(' ')}
    >
      <Container>
        <div className={styles.heading}>
          {eyebrow && <p className={styles.eyebrow}>{eyebrow}</p>}
          <h2 id={headingId} className={styles.title}>
            {title}
          </h2>
          {intro && <div className={styles.intro}>{intro}</div>}
        </div>
        {children}
      </Container>
    </section>
  );
}
