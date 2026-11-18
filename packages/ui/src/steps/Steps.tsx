import { Check } from 'lucide-react';
import styles from './steps.module.css';

export interface StepsProps {
  /** Accessible name of the list, e.g. "Les étapes". */
  label: string;
  steps: readonly string[];
  /** Index of the current step (0-based). */
  current: number;
  /** Visually hidden state words for assistive technologies. */
  doneLabel: string;
  currentLabel: string;
}

/** Progress through a short sequence of steps (sign-up). Done steps carry a check. */
export function Steps({ label, steps, current, doneLabel, currentLabel }: StepsProps) {
  return (
    <ol className={styles.steps} aria-label={label}>
      {steps.map((step, index) => {
        const done = index < current;
        const isCurrent = index === current;
        return (
          <li
            key={step}
            className={[styles.step, done && styles.done, isCurrent && styles.current]
              .filter(Boolean)
              .join(' ')}
            aria-current={isCurrent ? 'step' : undefined}
          >
            <span className={styles.number} aria-hidden="true">
              {done ? <Check size={16} strokeWidth={1.75} /> : index + 1}
            </span>
            <span>
              {step}
              {done && <span className={styles.hidden}> ({doneLabel})</span>}
              {isCurrent && <span className={styles.hidden}> ({currentLabel})</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
