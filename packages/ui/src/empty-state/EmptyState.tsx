import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import styles from './empty-state.module.css';

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  text?: string;
  action?: ReactNode;
}

/** Empty list: what is missing and what to do. */
export function EmptyState({ icon: Icon, title, text, action }: EmptyStateProps) {
  return (
    <div className={styles.empty}>
      <span className={styles.icon} aria-hidden="true">
        <Icon size={24} strokeWidth={1.75} />
      </span>
      <p className={styles.title}>{title}</p>
      {text && <p className={styles.text}>{text}</p>}
      {action}
    </div>
  );
}
