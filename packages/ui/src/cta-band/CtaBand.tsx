import type { ReactNode } from 'react';
import { Container } from '../container/Container';
import styles from './cta-band.module.css';

export interface CtaBandProps {
  title: string;
  text: string;
  action: ReactNode;
}

/** Dark closing band with a single call to action. */
export function CtaBand({ title, text, action }: CtaBandProps) {
  return (
    <section className={styles.band} aria-labelledby="cta-band-title">
      <Container className={styles.inner}>
        <div className={styles.text}>
          <h2 id="cta-band-title" className={styles.title}>
            {title}
          </h2>
          <p className={styles.lead}>{text}</p>
        </div>
        {action}
      </Container>
    </section>
  );
}
