import styles from './logo.module.css';

export interface LogoProps {
  /** Product name, translated by the caller. */
  name: string;
  href: string;
  /** Light mark on dark backgrounds. */
  inverted?: boolean;
}

/** The product sign: a LaTeX backslash with a gold dot, followed by the product name. */
export function Logo({ name, href, inverted = false }: LogoProps) {
  return (
    <a className={[styles.logo, inverted && styles.inverted].filter(Boolean).join(' ')} href={href}>
      <span className={styles.mark} aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 26 26">
          <path className={styles.stroke} d="M8 4 L18 22" strokeWidth="3" strokeLinecap="round" />
          <circle className={styles.dot} cx="20" cy="7" r="3" />
        </svg>
      </span>
      <span className={styles.name}>{name}</span>
    </a>
  );
}
