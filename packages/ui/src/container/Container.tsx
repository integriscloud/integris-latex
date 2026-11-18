import type { HTMLAttributes } from 'react';
import styles from './container.module.css';

export function Container({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={[styles.container, className].filter(Boolean).join(' ')} {...props} />;
}
