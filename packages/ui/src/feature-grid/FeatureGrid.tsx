import type { ReactNode } from 'react';
import styles from './feature-grid.module.css';

export interface Feature {
  /** Decorative icon (aria-hidden), 24 px. */
  icon: ReactNode;
  title: string;
  text: string;
}

/** Numbered feature cards. */
export function FeatureGrid({ features }: { features: readonly Feature[] }) {
  return (
    <ul className={styles.grid}>
      {features.map((feature, index) => (
        <li key={feature.title} className={styles.card}>
          <div className={styles.top}>
            <span className={styles.icon}>{feature.icon}</span>
            <span className={styles.number} aria-hidden="true">
              {String(index + 1).padStart(2, '0')}
            </span>
          </div>
          <h3 className={styles.title}>{feature.title}</h3>
          <p className={styles.text}>{feature.text}</p>
        </li>
      ))}
    </ul>
  );
}
