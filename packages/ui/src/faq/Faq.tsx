import { ChevronDown } from 'lucide-react';
import styles from './faq.module.css';

export interface FaqItem {
  question: string;
  answer: string;
}

/** Questions and answers, each one expandable. */
export function Faq({ items }: { items: readonly FaqItem[] }) {
  return (
    <div className={styles.list}>
      {items.map((item) => (
        <details key={item.question} className={styles.item}>
          <summary className={styles.question}>
            {item.question}
            <ChevronDown
              className={styles.chevron}
              size={20}
              strokeWidth={1.75}
              aria-hidden="true"
            />
          </summary>
          <p className={styles.answer}>{item.answer}</p>
        </details>
      ))}
    </div>
  );
}
