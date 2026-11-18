import { Check, Star } from 'lucide-react';
import styles from './journey.module.css';

export interface JourneyStep {
  title: string;
  text: string;
}

export interface JourneyTimelineProps {
  /** Accessible name of the timeline. */
  label: string;
  /** Steps in order: all done but the last two, the next-to-last in progress, the last the goal. */
  steps: readonly JourneyStep[];
}

/** Animated path from the first step to the goal (home page hero). */
export function JourneyTimeline({ label, steps }: JourneyTimelineProps) {
  const current = steps.length - 2;
  const goal = steps.length - 1;

  return (
    <div className={styles.card}>
      <ol className={styles.steps} aria-label={label}>
        {steps.map((step, index) => {
          const state = index < current ? 'done' : index === current ? 'current' : 'goal';
          return (
            <li key={step.title} className={`${styles.step} ${styles[state]}`}>
              {index < goal && (
                <span className={styles.track} aria-hidden="true">
                  <span className={styles.fill} />
                </span>
              )}
              <span className={styles.marker} aria-hidden="true">
                {state === 'done' && (
                  <span className={styles.dot}>
                    <Check size={16} strokeWidth={2.5} />
                  </span>
                )}
                {state === 'current' && (
                  <span className={styles.ring}>
                    <span className={styles.pulse} />
                  </span>
                )}
                {state === 'goal' && (
                  <span className={styles.star}>
                    <Star size={20} strokeWidth={1.75} />
                  </span>
                )}
              </span>
              <span className={styles.body}>
                <span className={styles.number}>{String(index + 1).padStart(2, '0')}</span>
                <span className={styles.title}>{step.title}</span>
                <span className={styles.text}>{step.text}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
