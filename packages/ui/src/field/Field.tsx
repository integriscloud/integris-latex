'use client';

import { CircleAlert, Eye, EyeOff } from 'lucide-react';
import {
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  useId,
  useState,
} from 'react';
import styles from './field.module.css';

interface FieldFrameProps {
  id: string;
  label: string;
  /** Visible marker next to the label, e.g. "(facultatif)". */
  optionalLabel?: string;
  help?: string;
  error?: string;
  children: ReactNode;
}

/** Label, help text and error message around an input. */
function FieldFrame({ id, label, optionalLabel, help, error, children }: FieldFrameProps) {
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
        {optionalLabel && <span className={styles.optional}> {optionalLabel}</span>}
      </label>
      {children}
      {help && !error && (
        <p className={styles.help} id={`${id}-help`}>
          {help}
        </p>
      )}
      {error && (
        <p className={styles.error} id={`${id}-error`}>
          <CircleAlert
            className={styles.errorIcon}
            size={16}
            strokeWidth={1.75}
            aria-hidden="true"
          />
          {error}
        </p>
      )}
    </div>
  );
}

const describedBy = (id: string, help?: string, error?: string) =>
  error ? `${id}-error` : help ? `${id}-help` : undefined;

const boxClass = (error?: string) =>
  [styles.box, error && styles.invalid].filter(Boolean).join(' ');

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  optionalLabel?: string;
  help?: string;
  error?: string;
}

export function TextField({ label, optionalLabel, help, error, ...props }: TextFieldProps) {
  const id = useId();
  return (
    <FieldFrame id={id} label={label} optionalLabel={optionalLabel} help={help} error={error}>
      <div className={boxClass(error)}>
        <input
          id={id}
          className={styles.input}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, help, error)}
          {...props}
        />
      </div>
    </FieldFrame>
  );
}

export interface PasswordFieldProps extends Omit<TextFieldProps, 'type'> {
  /** Accessible names of the show/hide button. */
  showLabel: string;
  hideLabel: string;
}

export function PasswordField({
  label,
  optionalLabel,
  help,
  error,
  showLabel,
  hideLabel,
  ...props
}: PasswordFieldProps) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const Icon = visible ? EyeOff : Eye;
  return (
    <FieldFrame id={id} label={label} optionalLabel={optionalLabel} help={help} error={error}>
      <div className={boxClass(error)}>
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          className={styles.input}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, help, error)}
          {...props}
        />
        <button
          type="button"
          className={styles.toggle}
          aria-label={visible ? hideLabel : showLabel}
          aria-pressed={visible}
          onClick={() => setVisible((value) => !value)}
        >
          <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
    </FieldFrame>
  );
}

export interface PhoneFieldProps extends Omit<TextFieldProps, 'type' | 'inputMode'> {
  dialCodes: readonly string[];
  dialCode: string;
  onDialCodeChange: (dialCode: string) => void;
  /** Accessible name of the country code selector. */
  dialCodeLabel: string;
}

/** Phone number with a country calling code selector (allowed codes come from the API). */
export function PhoneField({
  label,
  optionalLabel,
  help,
  error,
  dialCodes,
  dialCode,
  onDialCodeChange,
  dialCodeLabel,
  ...props
}: PhoneFieldProps) {
  const id = useId();
  return (
    <FieldFrame id={id} label={label} optionalLabel={optionalLabel} help={help} error={error}>
      <div className={boxClass(error)}>
        <select
          className={styles.prefix}
          aria-label={dialCodeLabel}
          value={dialCode}
          onChange={(event) => onDialCodeChange(event.target.value)}
        >
          {dialCodes.map((code) => (
            <option key={code} value={code}>
              +{code}
            </option>
          ))}
        </select>
        <input
          id={id}
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          className={`${styles.input} ${styles.tel}`}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, help, error)}
          {...props}
        />
      </div>
    </FieldFrame>
  );
}

export interface TextAreaFieldProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'id'
> {
  label: string;
  optionalLabel?: string;
  help?: string;
  error?: string;
}

/** Text on several lines (comments, messages); grows with the text up to a few lines. */
export function TextAreaField({ label, optionalLabel, help, error, ...props }: TextAreaFieldProps) {
  const id = useId();
  return (
    <FieldFrame id={id} label={label} optionalLabel={optionalLabel} help={help} error={error}>
      <div className={boxClass(error)}>
        <textarea
          id={id}
          rows={3}
          className={`${styles.input} ${styles.textarea}`}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, help, error)}
          {...props}
        />
      </div>
    </FieldFrame>
  );
}
