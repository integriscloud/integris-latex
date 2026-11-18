'use client';

import type { AuthConfig, MeResponse } from '@integris/shared';
import { Alert, AuthCard, Button, PasswordField, TextField } from '@integris/ui';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { useRouter } from '../../i18n/navigation';
import { apiPost, type ClientError } from '../../lib/api-client';
import styles from './auth-forms.module.css';
import { useErrorMessage } from './use-auth-request';

/** Add or change the e-mail address: a confirmation link is sent first. */
export function EmailForm({ me, locale }: { me: MeResponse; locale: string }) {
  const t = useTranslations('Account');
  const ta = useTranslations('Auth');
  const message = useErrorMessage();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<ClientError | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSentTo(null);
    const result = await apiPost('auth/email', { email, locale });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setSentTo(email.trim().toLowerCase());
    setEmail('');
    router.refresh();
  };

  return (
    <AuthCard>
      <section className={styles.section} aria-labelledby="account-email">
        <h2 className={styles.sectionTitle} id="account-email">
          {t('emailTitle')}
        </h2>
        <p className={styles.muted}>{t('emailText')}</p>
        <p className={styles.text}>
          {me.user.email ? t('emailCurrent', { email: me.user.email }) : t('emailNone')}
        </p>
        {me.user.pendingEmail && !sentTo && (
          <Alert tone="info">{t('emailPending', { email: me.user.pendingEmail })}</Alert>
        )}
        <form onSubmit={submit} noValidate className={styles.form}>
          <TextField
            label={ta('fields.email')}
            type="email"
            autoComplete="email"
            placeholder={ta('fields.emailPlaceholder')}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            error={error ? message(error) : undefined}
            required
          />
          {sentTo && <Alert tone="success">{t('emailSent', { email: sentTo })}</Alert>}
          <div>
            <Button type="submit" variant="secondary" busy={busy}>
              {busy ? t('emailSubmitting') : t('emailSubmit')}
            </Button>
          </div>
        </form>
      </section>
    </AuthCard>
  );
}

/** Set or change the password (needs a confirmed e-mail address). */
export function PasswordForm({ me, config }: { me: MeResponse; config: AuthConfig }) {
  const t = useTranslations('Account');
  const ta = useTranslations('Auth');
  const message = useErrorMessage();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const result = await apiPost('auth/password', {
      currentPassword: me.user.hasPassword ? current : undefined,
      newPassword: next,
    });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setSaved(true);
    setCurrent('');
    setNext('');
  };

  return (
    <AuthCard>
      <section className={styles.section} aria-labelledby="account-password">
        <h2 className={styles.sectionTitle} id="account-password">
          {t('passwordTitle')}
        </h2>
        <p className={styles.muted}>{t('passwordText')}</p>
        {me.user.email ? (
          <form onSubmit={submit} noValidate className={styles.form}>
            {/* Lets password managers attach the password to the right account. */}
            <input
              type="email"
              name="username"
              autoComplete="username"
              value={me.user.email}
              readOnly
              hidden
            />
            {me.user.hasPassword && (
              <PasswordField
                label={ta('fields.currentPassword')}
                showLabel={ta('fields.showPassword')}
                hideLabel={ta('fields.hidePassword')}
                autoComplete="current-password"
                value={current}
                onChange={(event) => setCurrent(event.target.value)}
                required
              />
            )}
            <PasswordField
              label={ta('fields.newPassword')}
              showLabel={ta('fields.showPassword')}
              hideLabel={ta('fields.hidePassword')}
              autoComplete="new-password"
              help={ta('fields.passwordHelp', { min: config.passwordMinLength })}
              value={next}
              onChange={(event) => setNext(event.target.value)}
              required
            />
            {error && <Alert tone="error">{message(error)}</Alert>}
            {saved && <Alert tone="success">{t('passwordSaved')}</Alert>}
            <div>
              <Button type="submit" variant="secondary" busy={busy}>
                {busy ? t('passwordSubmitting') : t('passwordSubmit')}
              </Button>
            </div>
          </form>
        ) : (
          <Alert tone="info">{t('passwordNeedsEmail')}</Alert>
        )}
      </section>
    </AuthCard>
  );
}
