'use client';

import { Alert, Button, TextField } from '@integris/ui';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Link } from '../../i18n/navigation';
import type { ClientError } from '../../lib/api-client';
import styles from './auth-forms.module.css';
import { CaptchaNotice } from './CaptchaNotice';
import { useAuthRequest, useErrorMessage } from './use-auth-request';

export function ForgotPasswordForm({ locale }: { locale: string }) {
  const t = useTranslations('Auth');
  const message = useErrorMessage();
  const { send, captchaRequired, captchaState } = useAuthRequest();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSent(false);
    const result = await send('auth/password/forgot', { email, locale });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setSent(true);
  };

  return (
    <form onSubmit={submit} noValidate className={styles.form}>
      <TextField
        label={t('fields.email')}
        type="email"
        autoComplete="email"
        placeholder={t('fields.emailPlaceholder')}
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        error={error ? message(error) : undefined}
        required
      />
      {sent && <Alert tone="success">{t('forgot.sent')}</Alert>}
      {captchaRequired && <CaptchaNotice state={captchaState} />}
      <Button type="submit" size="large" fullWidth busy={busy}>
        {busy ? t('forgot.submitting') : t('forgot.submit')}
      </Button>
      <p className={styles.muted}>{t('forgot.phoneHint')}</p>
      <p className={styles.links}>
        <Link href="/login">{t('forgot.backToLogin')}</Link>
      </p>
    </form>
  );
}
