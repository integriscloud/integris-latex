import { FileText } from 'lucide-react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import styles from './template-card.module.css';

export interface TemplateCardProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  title: string;
  description?: string | null;
  /** Category or "official template" badge. */
  badge?: ReactNode;
}

/** A template to choose in the gallery: a radio button presented as a card. */
export function TemplateCard({
  title,
  description,
  badge,
  className,
  ...props
}: TemplateCardProps) {
  return (
    <label className={[styles.card, className].filter(Boolean).join(' ')}>
      <input type="radio" className={styles.input} {...props} />
      <span className={styles.icon} aria-hidden="true">
        <FileText size={24} strokeWidth={1.75} />
      </span>
      <span className={styles.text}>
        <span className={styles.title}>{title}</span>
        {description && <span className={styles.description}>{description}</span>}
        {badge && <span>{badge}</span>}
      </span>
    </label>
  );
}
