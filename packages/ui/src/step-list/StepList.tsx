import styles from './step-list.module.css';

export interface Step {
  title: string;
  text: string;
}

/** An ordered list of large numbered steps. */
export function StepList({ steps }: { steps: readonly Step[] }) {
  return (
    <ol className={styles.list}>
      {steps.map((step, index) => (
        <li key={step.title} className={styles.step}>
          <span className={styles.number} aria-hidden="true">
            {String(index + 1).padStart(2, '0')}
          </span>
          <h3 className={styles.title}>{step.title}</h3>
          <p className={styles.text}>{step.text}</p>
        </li>
      ))}
    </ol>
  );
}
