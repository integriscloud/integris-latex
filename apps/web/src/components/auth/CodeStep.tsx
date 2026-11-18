'use client';

import { Alert, Button, OtpInput } from '@integris/ui';
import { useTranslations } from 'next-intl';
import { type FormEvent, type ReactNode, useState } from 'react';
import styles from './auth-forms.module.css';
import { useCountdown } from './use-countdown';

export interface CodeStepProps {
  phone: string;
  length: number;
  /** Timestamp (ms) from which a new code can be requested. */
  resendAt: number;
  submitLabel: string;
  busyLabel: string;
  busy: boolean;
  error?: string;
  /** Extra content under the error, e.g. a link to sign up. */
  errorAction?: ReactNode;
  notice?: ReactNode;
  onSubmit: (code: string) => void;
  onResend: () => void;
  /** Shown as « Modifier le numéro » when the user typed the number. */
  onChangeNumber?: () => void;
}

/** Entry of the SMS code: one box per digit, resend after the delay, change of number. */
export function CodeStep({
  phone,
  length,
  resendAt,
  submitLabel,
  busyLabel,
  busy,
  error,
  errorAction,
  notice,
  onSubmit,
  onResend,
  onChangeNumber,
}: CodeStepProps) {
  const t = useTranslations('Auth');
  const [code, setCode] = useState('');
  const [incomplete, setIncomplete] = useState(false);
  const wait = useCountdown(resendAt);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!new RegExp(`^\\d{${length}}$`).test(code)) {
      setIncomplete(true);
      return;
    }
    setIncomplete(false);
    onSubmit(code);
  };

  return (
    <form onSubmit={submit} noValidate className={styles.form}>
      <p className={styles.text}>
        {t('code.sentTo', { phone })}{' '}
        {onChangeNumber && (
          <Button variant="ghost" onClick={onChangeNumber}>
            {t('code.changeNumber')}
          </Button>
        )}
      </p>
      <OtpInput
        label={t('fields.code')}
        digitLabel={(index, total) => t('fields.codeDigit', { index, length: total })}
        length={length}
        value={code}
        onChange={(value) => {
          setCode(value);
          setIncomplete(false);
        }}
        error={incomplete ? t('code.incomplete', { length }) : undefined}
        autoFocus
      />
      {error && (
        <Alert tone="error">
          <span>{error}</span>
          {errorAction}
        </Alert>
      )}
      {notice}
      <Button type="submit" size="large" fullWidth busy={busy}>
        {busy ? busyLabel : submitLabel}
      </Button>
      <Button variant="ghost" onClick={onResend} disabled={wait > 0 || busy}>
        {wait > 0 ? t('code.resendIn', { seconds: wait }) : t('code.resend')}
      </Button>
    </form>
  );
}
