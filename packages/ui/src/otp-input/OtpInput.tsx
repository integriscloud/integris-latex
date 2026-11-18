'use client';

import { CircleAlert } from 'lucide-react';
import { type ClipboardEvent, type KeyboardEvent, useId, useRef } from 'react';
import { insertDigits, onlyDigits, typedText } from './digits';
import styles from './otp-input.module.css';

export interface OtpInputProps {
  /** Group label, e.g. "Code reçu par SMS". */
  label: string;
  /** Accessible name of each box; `{index}` and `{length}` are replaced. */
  digitLabel: (index: number, length: number) => string;
  length: number;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}

/** One box per digit, with paste and SMS autofill (`one-time-code`) spread across the boxes. */
export function OtpInput({
  label,
  digitLabel,
  length,
  value,
  onChange,
  error,
  disabled,
  autoFocus,
}: OtpInputProps) {
  const id = useId();
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const focus = (index: number) => refs.current[Math.max(0, Math.min(index, length - 1))]?.focus();

  const type = (index: number, typed: string) => {
    const next = insertDigits(value, index, typed, length);
    onChange(next);
    if (typed) focus(index + onlyDigits(typed, length).length);
  };

  const onKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && !value[index]?.trim() && index > 0) {
      event.preventDefault();
      onChange(insertDigits(value, index - 1, '', length));
      focus(index - 1);
    } else if (event.key === 'ArrowLeft') {
      focus(index - 1);
    } else if (event.key === 'ArrowRight') {
      focus(index + 1);
    }
  };

  const onPaste = (index: number, event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    type(index, event.clipboardData.getData('text'));
  };

  return (
    <fieldset
      className={[styles.group, error && styles.invalid].filter(Boolean).join(' ')}
      aria-describedby={error ? `${id}-error` : undefined}
      disabled={disabled}
    >
      <legend className={styles.legend}>{label}</legend>
      <div className={styles.digits}>
        {Array.from({ length }, (_, index) => (
          <input
            key={index}
            ref={(element) => {
              refs.current[index] = element;
            }}
            className={styles.digit}
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete={index === 0 ? 'one-time-code' : 'off'}
            // Room for a full code so SMS autofill and paste reach onChange in any box.
            maxLength={length}
            aria-label={digitLabel(index + 1, length)}
            aria-invalid={error ? true : undefined}
            value={value[index]?.trim() ?? ''}
            autoFocus={autoFocus && index === 0}
            onChange={(event) => type(index, typedText(value[index], event.target.value))}
            onKeyDown={(event) => onKeyDown(index, event)}
            onPaste={(event) => onPaste(index, event)}
            onFocus={(event) => event.target.select()}
          />
        ))}
      </div>
      {error && (
        <p className={styles.error} id={`${id}-error`} role="alert">
          <CircleAlert
            className={styles.errorIcon}
            size={16}
            strokeWidth={1.75}
            aria-hidden="true"
          />
          {error}
        </p>
      )}
    </fieldset>
  );
}
