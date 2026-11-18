import { CircleAlert, CircleCheck, LoaderCircle } from 'lucide-react';
import styles from './captcha-box.module.css';

export type CaptchaState = 'solving' | 'done' | 'error';

export interface CaptchaBoxProps {
  title: string;
  text: string;
  state: CaptchaState;
  /** Text of the current state, e.g. "Vérification en cours…". */
  stateLabel: string;
}

/**
 * Anti-robot check shown after failed attempts. The browser solves a small computation by itself:
 * nothing to click or type, the box only reports progress.
 */
export function CaptchaBox({ title, text, state, stateLabel }: CaptchaBoxProps) {
  const Icon = state === 'done' ? CircleCheck : state === 'error' ? CircleAlert : LoaderCircle;
  const stateClass = state === 'done' ? styles.done : state === 'error' ? styles.error : '';
  return (
    <div className={styles.box}>
      <p className={styles.title}>{title}</p>
      <p className={styles.text}>{text}</p>
      <p className={`${styles.state} ${stateClass}`} role="status" aria-live="polite">
        <Icon
          className={state === 'solving' ? styles.spinner : undefined}
          size={20}
          strokeWidth={1.75}
          aria-hidden="true"
        />
        {stateLabel}
      </p>
    </div>
  );
}
