import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import styles from './callout.module.css';

export interface CalloutProps {
  /** Decorative icon (aria-hidden), 24 px. */
  icon?: ReactNode;
  title: string;
  text: string;
  /** Short points, each shown with a check mark. */
  points?: readonly string[];
}

/** A highlighted box with a title, a paragraph and optional points. */
export function Callout({ icon, title, text, points }: CalloutProps) {
  return (
    <aside className={styles.callout}>
      {icon && <span className={styles.icon}>{icon}</span>}
      <div className={styles.content}>
        <h3 className={styles.title}>{title}</h3>
        <p className={styles.text}>{text}</p>
        {points && points.length > 0 && (
          <ul className={styles.points}>
            {points.map((point) => (
              <li key={point} className={styles.point}>
                <Check className={styles.check} size={20} strokeWidth={1.75} aria-hidden="true" />
                {point}
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
