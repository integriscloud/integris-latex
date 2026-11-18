'use client';

import { formatPhone } from '@integris/shared';
import { Alert, AuthCard, Button } from '@integris/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { ClientError } from '../../lib/api-client';
import styles from './auth-forms.module.css';
import { CaptchaNotice } from './CaptchaNotice';
import { CodeStep } from './CodeStep';
import { useAuthRequest, useErrorMessage } from './use-auth-request';

export interface ReauthPanelProps {
  phone: string;
  locale: string;
  otpLength: number;
  /** Called with the Unix time (seconds) until which changes are allowed. */
  onConfirmed: (reauthUntil: number) => void;
}

/** Confirms the identity with a code sent to the account phone before a sensitive change. */
export function ReauthPanel({ phone, locale, otpLength, onConfirmed }: ReauthPanelProps) {
  const t = useTranslations('Account');
  const ta = useTranslations('Auth');
  const message = useErrorMessage();
  const { send, captchaRequired, captchaState } = useAuthRequest();
  const [codeSent, setCodeSent] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  const [resent, setResent] = useState(false);

  const requestCode = async () => {
    setBusy(true);
    setError(null);
    const result = await send<{ resendAfter: number }>('auth/reauth/otp', { locale }, 'reauth_otp');
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    setResendAt(Date.now() + result.data.resendAfter * 1000);
    setCodeSent(true);
    return true;
  };

  const confirm = async (code: string) => {
    setBusy(true);
    setError(null);
    setResent(false);
    const result = await send<{ reauthUntil: number }>('auth/reauth', { code }, 'reauth');
    setBusy(false);
    if (!result.ok) return setError(result.error);
    onConfirmed(result.data.reauthUntil);
  };

  return (
    <AuthCard>
      <section className={styles.section} aria-labelledby="account-reauth">
        <h2 className={styles.sectionTitle} id="account-reauth">
          {t('reauthTitle')}
        </h2>
        <p className={styles.muted}>{t('reauthText', { phone: formatPhone(phone) })}</p>
        {codeSent ? (
          <CodeStep
            phone={formatPhone(phone)}
            length={otpLength}
            resendAt={resendAt}
            submitLabel={t('reauthConfirm')}
            busyLabel={t('reauthConfirming')}
            busy={busy}
            error={error ? message(error) : undefined}
            notice={
              <>
                {captchaRequired && <CaptchaNotice state={captchaState} />}
                {resent && <Alert tone="success">{ta('code.resent')}</Alert>}
              </>
            }
            onSubmit={confirm}
            onResend={async () => {
              setResent(false);
              if (await requestCode()) setResent(true);
            }}
          />
        ) : (
          <>
            {error && <Alert tone="error">{message(error)}</Alert>}
            {captchaRequired && <CaptchaNotice state={captchaState} />}
            <div>
              <Button variant="secondary" busy={busy} onClick={requestCode}>
                {busy ? t('reauthSending') : t('reauthSend')}
              </Button>
            </div>
          </>
        )}
      </section>
    </AuthCard>
  );
}
