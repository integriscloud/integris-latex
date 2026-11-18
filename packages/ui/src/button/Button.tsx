import { ArrowRight } from 'lucide-react';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from 'react';
import styles from './button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'accent';
export type ButtonSize = 'default' | 'large';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant = 'primary', className, type = 'button', ...props }: ButtonProps) {
  const classes = [styles.button, styles[variant], className].filter(Boolean).join(' ');
  return <button type={type} className={classes} {...props} />;
}

export interface ButtonLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Show a trailing arrow that slides on hover (main calls to action). */
  arrow?: boolean;
}

/** A link styled as a button, for navigation actions. */
export function ButtonLink({
  variant = 'primary',
  size = 'default',
  arrow = false,
  className,
  children,
  ...props
}: ButtonLinkProps) {
  const classes = [
    styles.button,
    styles[variant],
    size === 'large' && styles.large,
    styles.link,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <a className={classes} {...props}>
      {children}
      {arrow && (
        <ArrowRight className={styles.icon} size={20} strokeWidth={1.75} aria-hidden="true" />
      )}
    </a>
  );
}
