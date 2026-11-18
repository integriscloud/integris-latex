import type { InputHTMLAttributes, ReactNode } from 'react';
import styles from './checkbox.module.css';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  children: ReactNode;
  invalid?: boolean;
}

export function Checkbox({ children, invalid, ...props }: CheckboxProps) {
  return (
    <label className={[styles.checkbox, invalid && styles.invalid].filter(Boolean).join(' ')}>
      <input
        type="checkbox"
        className={styles.input}
        aria-invalid={invalid ? true : undefined}
        {...props}
      />
      <span className={styles.label}>{children}</span>
    </label>
  );
}
