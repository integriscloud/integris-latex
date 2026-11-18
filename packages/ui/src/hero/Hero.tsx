import type { ReactNode } from 'react';
import { Container } from '../container/Container';
import styles from './hero.module.css';

export interface HeroProps {
  eyebrow: string;
  /** Page title (h1). Use HeroAccent for the highlighted words. */
  title: ReactNode;
  lead: string;
  actions: ReactNode;
  note?: string;
  /** Rendered under the text, e.g. a JourneyTimeline. */
  children?: ReactNode;
}

/** Centered page hero with staggered entrance animations. */
export function Hero({ eyebrow, title, lead, actions, note, children }: HeroProps) {
  return (
    <section className={styles.hero}>
      <Container className={styles.text}>
        <p className={styles.eyebrow}>{eyebrow}</p>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.lead}>{lead}</p>
        <div className={styles.actions}>{actions}</div>
        {note && <p className={styles.note}>{note}</p>}
      </Container>
      {children && <Container className={styles.extra}>{children}</Container>}
    </section>
  );
}

/** Highlighted words of a hero title: serif italic, gold. */
export function HeroAccent({ children }: { children: ReactNode }) {
  return <em className={styles.accent}>{children}</em>;
}
