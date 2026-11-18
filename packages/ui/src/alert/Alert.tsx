import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import styles from './alert.module.css';

export type AlertTone = 'error' | 'success' | 'info' | 'warning' | 'note';

const icons = {
  error: CircleAlert,
  success: CircleCheck,
  info: Info,
  warning: TriangleAlert,
  note: Info,
};

export interface AlertProps {
  tone: AlertTone;
  /**
   * False when the alert sits inside an `aria-live` region of the page, so it is not announced
   * twice.
   */
  announce?: boolean;
  children: ReactNode;
}

/** Message in a form or page. Errors are announced at once; success always shows a check. */
export function Alert({ tone, announce = true, children }: AlertProps) {
  const Icon = icons[tone];
  const role = announce ? (tone === 'error' ? 'alert' : 'status') : undefined;
  return (
    <div className={`${styles.alert} ${styles[tone]}`} role={role}>
      <Icon className={styles.icon} size={20} strokeWidth={1.75} aria-hidden="true" />
      <div className={styles.body}>{children}</div>
    </div>
  );
}
