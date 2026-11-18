import type { ReactNode } from 'react';
import { Container } from '../container/Container';
import styles from './trust-strip.module.css';

export interface TrustItem {
  /** Decorative icon (aria-hidden), 24 px. */
  icon: ReactNode;
  label: string;
}

export interface TrustStripProps {
  label: string;
  items: readonly TrustItem[];
}

/** A band of short reassurance points. */
export function TrustStrip({ label, items }: TrustStripProps) {
  return (
    <section aria-label={label} className={styles.strip}>
      <Container>
        <ul className={styles.list}>
          {items.map((item) => (
            <li key={item.label} className={styles.item}>
              <span className={styles.icon}>{item.icon}</span>
              {item.label}
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
