'use client';

import { type AuthConfig, formatPhone, type MeResponse, normalizePhone } from '@integris/shared';
import { Alert, Button, PasswordField, PhoneField, Tabs, TextField } from '@integris/ui';
import { Mail, Smartphone } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Link, useRouter } from '../../i18n/navigation';
import type { ClientError } from '../../lib/api-client';
import styles from './auth-forms.module.css';
import { CaptchaNotice } from './CaptchaNotice';
import { CodeStep } from './CodeStep';
import { invitationReturnFromHash } from './token-from-hash';
import { useAuthRequest, useErrorMessage } from './use-auth-request';

type Mode = 'phone' | 'email';

export function LoginForm({ config, locale }: { config: AuthConfig; locale: string }) {
  const t = useTranslations('Auth');
  const router = useRouter();
  const message = useErrorMessage();
  const { send, captchaRequired, captchaState } = useAuthRequest();

  const [mode, setMode] = useState<Mode>('phone');
  const [dialCode, setDialCode] = useState(config.allowedDialCodes[0] ?? '');
  const [phone, setPhone] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  const [resent, setResent] = useState(false);

  // Signing in from an invitation: back to it afterwards.
  const [invite] = useState(() =>
    typeof window === 'undefined' ? null : invitationReturnFromHash(),
  );

  const open = (me: MeResponse) => {
    router.replace(invite ?? (me.currentSpaceId ? '/app' : '/spaces'));
    router.refresh();
  };

  const requestCode = async () => {
    setBusy(true);
    setError(null);
    const result = await send<{ resendAfter: number }>(
      'auth/otp',
      { phone, dialCode, purpose: 'login', locale },
      'otp',
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    setResendAt(Date.now() + result.data.resendAfter * 1000);
    setCodeSent(true);
    return true;
  };

  const onPhoneSubmit = async (event: FormEvent) => {
    event.preventDefault();
    await requestCode();
  };

  const onResend = async () => {
    setResent(false);
    if (await requestCode()) setResent(true);
  };

  const onCode = async (code: string) => {
    setBusy(true);
    setError(null);
    setResent(false);
    const result = await send<MeResponse>('auth/login/otp', { phone, dialCode, code }, 'login_otp');
    if (result.ok) return open(result.data);
    setBusy(false);
    setError(result.error);
  };

  const onEmailSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await send<MeResponse>(
      'auth/login/password',
      { email, password },
      'login_password',
    );
    if (result.ok) return open(result.data);
    setBusy(false);
    setError(result.error);
  };

  const switchMode = (next: string) => {
    setMode(next as Mode);
    setError(null);
  };

  const captcha = captchaRequired && <CaptchaNotice state={captchaState} />;
  const signupLink = (
    <Link href="/signup" className={styles.inlineLink}>
      {t('login.createWithNumber')}
    </Link>
  );

  return (
    <>
      <Tabs
        label={t('login.modes')}
        idPrefix="login"
        value={mode}
        onChange={switchMode}
        items={[
          { id: 'phone', label: t('login.phoneTab'), icon: Smartphone },
          { id: 'email', label: t('login.emailTab'), icon: Mail },
        ]}
      />

      {mode === 'phone' && (
        <div role="tabpanel" id="login-panel-phone" aria-labelledby="login-tab-phone">
          {codeSent ? (
            <CodeStep
              phone={formatPhone(normalizePhone(phone, dialCode) ?? `+${dialCode} ${phone}`)}
              length={config.otpLength}
              resendAt={resendAt}
              submitLabel={t('login.submit')}
              busyLabel={t('login.submitting')}
              busy={busy}
              error={error ? message(error) : undefined}
              errorAction={error?.code === 'no_account' ? signupLink : undefined}
              notice={
                <>
                  {captcha}
                  {resent && <Alert tone="success">{t('code.resent')}</Alert>}
                </>
              }
              onSubmit={onCode}
              onResend={onResend}
              onChangeNumber={() => {
                setCodeSent(false);
                setError(null);
              }}
            />
          ) : (
            <form onSubmit={onPhoneSubmit} noValidate className={styles.form}>
              <PhoneField
                label={t('fields.phone')}
                dialCodeLabel={t('fields.dialCode')}
                dialCodes={config.allowedDialCodes}
                dialCode={dialCode}
                onDialCodeChange={setDialCode}
                placeholder={t('fields.phonePlaceholder')}
                help={t('login.codeHelp', { length: config.otpLength })}
                error={error ? message(error) : undefined}
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                required
              />
              {captcha}
              <Button type="submit" size="large" fullWidth busy={busy}>
                {busy ? t('login.sendingCode') : t('login.sendCode')}
              </Button>
            </form>
          )}
        </div>
      )}

      {mode === 'email' && (
        <div role="tabpanel" id="login-panel-email" aria-labelledby="login-tab-email">
          <form onSubmit={onEmailSubmit} noValidate className={styles.form}>
            <p className={styles.muted}>{t('login.emailHelp')}</p>
            <TextField
              label={t('fields.email')}
              type="email"
              autoComplete="email"
              placeholder={t('fields.emailPlaceholder')}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
            <PasswordField
              label={t('fields.password')}
              showLabel={t('fields.showPassword')}
              hideLabel={t('fields.hidePassword')}
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            <div className={styles.end}>
              <Link href="/forgot-password" className={styles.inlineLink}>
                {t('login.forgotPassword')}
              </Link>
            </div>
            {error && <Alert tone="error">{message(error)}</Alert>}
            {captcha}
            <Button type="submit" size="large" fullWidth busy={busy}>
              {busy ? t('login.submitting') : t('login.submit')}
            </Button>
          </form>
        </div>
      )}

      <p className={styles.links}>
        <span>
          {t('login.noAccount')}{' '}
          <Link href="/signup" className={styles.inlineLink}>
            {t('login.createAccount')}
          </Link>
        </span>
      </p>
    </>
  );
}
