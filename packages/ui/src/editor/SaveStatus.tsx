import {
  CircleAlert,
  CircleCheck,
  CloudUpload,
  LoaderCircle,
  TriangleAlert,
  WifiOff,
} from 'lucide-react';
import styles from './save-status.module.css';

export type SaveStatusValue = 'saved' | 'pending' | 'saving' | 'offline' | 'conflict' | 'error';

const icons = {
  saved: CircleCheck,
  pending: CloudUpload,
  saving: LoaderCircle,
  offline: WifiOff,
  conflict: TriangleAlert,
  error: CircleAlert,
};

export interface SaveStatusProps {
  status: SaveStatusValue;
  /** Text of each status ("Enregistré", "Enregistrement…"…). */
  labels: Record<SaveStatusValue, string>;
}

/** Where the open files stand against storage; "saved" always carries a check icon. */
export function SaveStatus({ status, labels }: SaveStatusProps) {
  const Icon = icons[status];
  return (
    <p className={`${styles.status} ${styles[status]}`} role="status">
      <Icon
        className={status === 'saving' ? styles.spin : undefined}
        size={16}
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <span className={styles.label}>{labels[status]}</span>
    </p>
  );
}
