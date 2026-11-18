import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import styles from './badge.module.css';

export type BadgeTone = 'neutral' | 'action' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export interface BadgeProps {
  tone?: BadgeTone;
  /** Success badges always carry a check: pass it here. */
  icon?: LucideIcon;
  children: ReactNode;
}

/** Small pill: role on a project, status, plan. */
export function Badge({ tone = 'neutral', icon: Icon, children }: BadgeProps) {
  return (
    <span className={`${styles.badge} ${styles[tone]}`}>
      {Icon && <Icon size={14} strokeWidth={1.75} aria-hidden="true" />}
      {children}
    </span>
  );
}
