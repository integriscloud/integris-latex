import type { LucideIcon } from 'lucide-react';
import type { ButtonHTMLAttributes, Ref } from 'react';
import styles from './icon-button.module.css';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: LucideIcon;
  /** Accessible name, required: the button shows no text. */
  label: string;
  tone?: 'default' | 'danger';
  ref?: Ref<HTMLButtonElement>;
}

/** Square 44 px button with an icon only. */
export function IconButton({
  icon: Icon,
  label,
  tone = 'default',
  className,
  ...props
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={[styles.button, tone === 'danger' && styles.danger, className]
        .filter(Boolean)
        .join(' ')}
      {...props}
    >
      <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}
