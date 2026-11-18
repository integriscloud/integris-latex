import { Info } from 'lucide-react';
import styles from './notice.module.css';

/** Informational message (e.g. data temporarily unavailable). */
export function Notice({ children }: { children: string }) {
  return (
    <p className={styles.notice} role="status">
      <Info className={styles.icon} size={20} strokeWidth={1.75} aria-hidden="true" />
      {children}
    </p>
  );
}
