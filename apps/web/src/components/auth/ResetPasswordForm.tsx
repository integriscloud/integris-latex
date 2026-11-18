'use client';

import type { AuthConfig } from '@integris/shared';
import { Alert, Button, PasswordField } from '@integris/ui';
import { useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useState } from 'react';
import { Link } from '../../i18n/navigation';
import { apiPost, type ClientError } from '../../lib/api-client';
import styles from './auth-forms.module.css';
import { takeTokenFromHash } from './token-from-hash';
import { useErrorMessage } from './use-auth-request';

export function ResetPasswordForm({ config }: { config: AuthConfig }) {
  const t = useTranslations('Auth');
  const message = useErrorMessage();
  // undefined: not read yet (server render); null: the link has no token.
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the fragment exists only in the browser
    setToken(takeTokenFromHash());
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    const result = await apiPost('auth/password/reset', { token, newPassword: password });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setDone(true);
  };

  if (token === null) {
    return (
      <Alert tone="error">
        <span>{t('reset.missingToken')}</span>
        <Link href="/forgot-password">{t('reset.newLink')}</Link>
      </Alert>
    );
  }

  if (done) {
    return (
      <Alert tone="success">
        <span>{t('reset.done')}</span>
        <Link href="/login">{t('reset.login')}</Link>
      </Alert>
    );
  }

  return (
    <form onSubmit={submit} noValidate className={styles.form}>
      <PasswordField
        label={t('fields.newPassword')}
        showLabel={t('fields.showPassword')}
        hideLabel={t('fields.hidePassword')}
        autoComplete="new-password"
        help={t('fields.passwordHelp', { min: config.passwordMinLength })}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        required
      />
      {error && (
        <Alert tone="error">
          <span>{message(error)}</span>
          {error.code === 'invalid_token' && (
            <Link href="/forgot-password">{t('reset.newLink')}</Link>
          )}
        </Alert>
      )}
      <Button type="submit" size="large" fullWidth busy={busy} disabled={!token}>
        {busy ? t('reset.submitting') : t('reset.submit')}
      </Button>
    </form>
  );
}
