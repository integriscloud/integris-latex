import { ArrowRight, type LucideIcon } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';
import styles from './space-card.module.css';

export interface SpaceCardProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  /** Badge shown next to the title, e.g. "Espace actuel". */
  badge?: string;
}

/** One space in "Choisir son espace": opens that space when activated. */
export function SpaceCard({
  icon: Icon,
  title,
  subtitle,
  badge,
  className,
  ...props
}: SpaceCardProps) {
  return (
    <button
      type="button"
      className={[styles.card, badge && styles.current, className].filter(Boolean).join(' ')}
      {...props}
    >
      <span className={styles.icon} aria-hidden="true">
        <Icon size={24} strokeWidth={1.75} />
      </span>
      <span className={styles.text}>
        <span className={styles.title}>
          {title}
          {badge && <span className={styles.badge}>{badge}</span>}
        </span>
        <span className={styles.subtitle}>{subtitle}</span>
      </span>
      <ArrowRight className={styles.arrow} size={24} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}
