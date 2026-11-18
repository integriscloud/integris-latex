import { ArrowRight } from 'lucide-react';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from 'react';
import styles from './button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'accent' | 'ghost';
export type ButtonSize = 'default' | 'large';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  /** Action in progress: the button is disabled and announced as busy (label ends with "…"). */
  busy?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'default',
  fullWidth = false,
  busy = false,
  className,
  type = 'button',
  disabled,
  ...props
}: ButtonProps) {
  const classes = [
    styles.button,
    styles[variant],
    size === 'large' && styles.large,
    fullWidth && styles.fullWidth,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...props}
    />
  );
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
