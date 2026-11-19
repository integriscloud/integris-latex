import { useId } from 'react';
import styles from './choice-cards.module.css';

export interface ChoiceCardOption<T extends string> {
  value: T;
  title: string;
  description: string;
}

export interface ChoiceCardsProps<T extends string> {
  /** Group label (legend), e.g. "Son rôle sur ce document". */
  label: string;
  value: T;
  options: readonly ChoiceCardOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
}

/**
 * One choice among a few, each with a short explanation (role selector of the sharing panel):
 * native radio buttons, the whole card is the target.
 */
export function ChoiceCards<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: ChoiceCardsProps<T>) {
  const name = useId();
  return (
    <fieldset className={styles.group} disabled={disabled}>
      <legend className={styles.legend}>{label}</legend>
      <div className={styles.options}>
        {options.map((option) => (
          <label
            key={option.value}
            className={[styles.card, option.value === value && styles.checked]
              .filter(Boolean)
              .join(' ')}
          >
            <input
              type="radio"
              className={styles.input}
              name={name}
              value={option.value}
              checked={option.value === value}
              onChange={() => onChange(option.value)}
            />
            <span className={styles.text}>
              <span className={styles.title}>{option.title}</span>
              <span className={styles.description}>{option.description}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
