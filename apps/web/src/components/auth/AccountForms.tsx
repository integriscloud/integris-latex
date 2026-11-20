'use client';

import type { AuthConfig, MeResponse } from '@integris/shared';
import { Alert, AuthCard, Button, PasswordField, TextField } from '@integris/ui';
import { useFormatter, useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { useRouter } from '../../i18n/navigation';
import { apiPost, type ClientError } from '../../lib/api-client';
import styles from './auth-forms.module.css';
import { ReauthPanel } from './ReauthPanel';
import { useErrorMessage } from './use-auth-request';
import { useCountdown } from './use-countdown';

interface FormProps {
  me: MeResponse;
  /** True while the identity confirmation by SMS code is valid. */
  canEdit: boolean;
  /** The API refused the change: the confirmation has expired. */
  onReauthRequired: () => void;
}

/**
 * E-mail and password of the account. Changing either needs a recent confirmation by SMS code,
 * asked for first and valid 10 minutes.
 */
export function AccountSecurity({
  me,
  config,
  locale,
}: {
  me: MeResponse;
  config: AuthConfig;
  locale: string;
}) {
  const t = useTranslations('Account');
  const format = useFormatter();
  const [reauthUntil, setReauthUntil] = useState(me.reauthUntil ?? 0);
  const canEdit = useCountdown(reauthUntil * 1000) > 0;
  const expire = () => setReauthUntil(0);

  return (
    <>
      {canEdit ? (
        <Alert tone="success">
          {t('reauthDone', {
            time: format.dateTime(new Date(reauthUntil * 1000), {
              hour: '2-digit',
              minute: '2-digit',
            }),
          })}
        </Alert>
      ) : (
        me.user.phone && (
          <ReauthPanel
            phone={me.user.phone}
            locale={locale}
            otpLength={config.otpLength}
            onConfirmed={setReauthUntil}
          />
        )
      )}
      <EmailForm me={me} locale={locale} canEdit={canEdit} onReauthRequired={expire} />
      <PasswordForm me={me} config={config} canEdit={canEdit} onReauthRequired={expire} />
    </>
  );
}

/** Add or change the e-mail address: a confirmation link is sent first. */
function EmailForm({ me, locale, canEdit, onReauthRequired }: FormProps & { locale: string }) {
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
    if (!result.ok) {
      if (result.error.code === 'reauth_required') onReauthRequired();
      return setError(result.error);
    }
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
        {sentTo && <Alert tone="success">{t('emailSent', { email: sentTo })}</Alert>}
        {error && !canEdit && <Alert tone="error">{message(error)}</Alert>}
        {/* Always shown: until the identity is confirmed by SMS (panel above), the field is
            disabled and says so. */}
        <form onSubmit={submit} noValidate className={styles.form}>
          <TextField
            label={ta('fields.email')}
            type="email"
            autoComplete="email"
            placeholder={ta('fields.emailPlaceholder')}
            value={email}
            disabled={!canEdit}
            help={canEdit ? undefined : t('emailNeedsReauth')}
            onChange={(event) => setEmail(event.target.value)}
            error={canEdit && error ? message(error) : undefined}
            required
          />
          <div>
            <Button type="submit" variant="secondary" busy={busy} disabled={!canEdit}>
              {busy ? t('emailSubmitting') : t('emailSubmit')}
            </Button>
          </div>
        </form>
      </section>
    </AuthCard>
  );
}

/** Set or change the password (needs a confirmed e-mail address). */
function PasswordForm({
  me,
  config,
  canEdit,
  onReauthRequired,
}: FormProps & { config: AuthConfig }) {
  const t = useTranslations('Account');
  const ta = useTranslations('Auth');
  const message = useErrorMessage();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const result = await apiPost('auth/password', { newPassword: password });
    setBusy(false);
    if (!result.ok) {
      if (result.error.code === 'reauth_required') onReauthRequired();
      return setError(result.error);
    }
    setSaved(true);
    setPassword('');
  };

  return (
    <AuthCard>
      <section className={styles.section} aria-labelledby="account-password">
        <h2 className={styles.sectionTitle} id="account-password">
          {t('passwordTitle')}
        </h2>
        <p className={styles.muted}>{t('passwordText')}</p>
        {saved && <Alert tone="success">{t('passwordSaved')}</Alert>}
        {error && !canEdit && <Alert tone="error">{message(error)}</Alert>}
        {!me.user.email ? (
          <Alert tone="info">{t('passwordNeedsEmail')}</Alert>
        ) : (
          canEdit && (
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
              <PasswordField
                label={ta('fields.newPassword')}
                showLabel={ta('fields.showPassword')}
                hideLabel={ta('fields.hidePassword')}
                autoComplete="new-password"
                help={ta('fields.passwordHelp', { min: config.passwordMinLength })}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
              {error && <Alert tone="error">{message(error)}</Alert>}
              <div>
                <Button type="submit" variant="secondary" busy={busy}>
                  {busy ? t('passwordSubmitting') : t('passwordSubmit')}
                </Button>
              </div>
            </form>
          )
        )}
      </section>
    </AuthCard>
  );
}
