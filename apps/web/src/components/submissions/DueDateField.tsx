'use client';

import { TextField } from '@integris/ui';
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import { useState } from 'react';
import { dateOrder, DEFAULT_DUE_TIME, type DueInput, dueFromInput, dueInputOf } from './dates';
import styles from './submissions.module.css';

/**
 * Text of a deadline being typed, read in the time zone the dates are shown in. `read` gives
 * the ISO instant, null when empty, or 'invalid'.
 */
export function useDueInput(initial: string | null) {
  const locale = useLocale();
  const timeZone = useTimeZone() ?? 'UTC';
  const [input, setInput] = useState<DueInput>(() => dueInputOf(initial, locale, timeZone));
  // The time zone of the browser comes after the first drawing: the text follows it until typed.
  const [typed, setTyped] = useState(false);
  const [zone, setZone] = useState(timeZone);
  if (zone !== timeZone) {
    setZone(timeZone);
    if (!typed) setInput(dueInputOf(initial, locale, timeZone));
  }
  return {
    input,
    setInput: (value: DueInput) => {
      setTyped(true);
      setInput(value);
    },
    clear: () => setInput({ date: '', time: '' }),
    read: () => dueFromInput(input, locale, timeZone),
  };
}

export interface DueDateFieldProps {
  legend: string;
  optionalLabel?: string;
  value: DueInput;
  onChange: (value: DueInput) => void;
  invalid: boolean;
}

/** Deadline typed as a date in the order of the language (jj/mm/aaaa) and a time (hh:mm). */
export function DueDateField({
  legend,
  optionalLabel,
  value,
  onChange,
  invalid,
}: DueDateFieldProps) {
  const t = useTranslations('Submissions.form');
  const locale = useLocale();
  const { order, separator } = dateOrder(locale);
  const pattern = order.map((part) => t(`letters.${part}`)).join(separator);
  return (
    <fieldset className={styles.fieldset}>
      <legend className={styles.legend}>
        {legend}
        {optionalLabel && <span className={styles.optional}> ({optionalLabel})</span>}
      </legend>
      <div className={styles.dueFields}>
        <TextField
          label={t('dueDate')}
          help={t('dueDateHelp', { pattern })}
          error={invalid ? t('dueInvalid', { pattern }) : undefined}
          placeholder={pattern}
          inputMode="numeric"
          autoComplete="off"
          maxLength={10}
          value={value.date}
          onChange={(event) => onChange({ ...value, date: event.target.value })}
        />
        <TextField
          label={t('dueTime')}
          help={t('dueTimeHelp', { time: DEFAULT_DUE_TIME })}
          placeholder={t('letters.time')}
          inputMode="numeric"
          autoComplete="off"
          maxLength={5}
          value={value.time}
          onChange={(event) => onChange({ ...value, time: event.target.value })}
        />
      </div>
    </fieldset>
  );
}
