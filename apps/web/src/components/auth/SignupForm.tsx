'use client';

import { type AuthConfig, formatPhone, type MeResponse, normalizePhone } from '@integris/shared';
import {
  Alert,
  AuthCard,
  AuthHeading,
  AuthPageLayout,
  AuthSideSection,
  Button,
  ButtonLink,
  Checkbox,
  PhoneField,
  Steps,
  TextField,
} from '@integris/ui';
import { useTranslations } from 'next-intl';
import { type FormEvent, type ReactNode, useState } from 'react';
import { getPathname, useRouter } from '../../i18n/navigation';
import type { ClientError } from '../../lib/api-client';
import styles from './auth-forms.module.css';
import { CaptchaNotice } from './CaptchaNotice';
import { CodeStep } from './CodeStep';
import { useAuthRequest, useErrorMessage } from './use-auth-request';

type Step = 0 | 1 | 2;

export interface SignupFormProps {
  config: AuthConfig;
  locale: 'fr' | 'en';
  brand: ReactNode;
  barEnd: ReactNode;
}

export function SignupForm({ config, locale, brand, barEnd }: SignupFormProps) {
  const t = useTranslations('Auth');
  const router = useRouter();
  const message = useErrorMessage();
  const { send, captchaRequired, captchaState } = useAuthRequest();

  const [step, setStep] = useState<Step>(0);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [dialCode, setDialCode] = useState(config.allowedDialCodes[0] ?? '');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [terms, setTerms] = useState(false);
  const [missing, setMissing] = useState<{ name?: boolean; terms?: boolean }>({});
  const [resendAt, setResendAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  const [resent, setResent] = useState(false);
  const [me, setMe] = useState<MeResponse | null>(null);

  const stepNames = [t('signup.stepProfile'), t('signup.stepVerify'), t('signup.stepReady')];

  const requestCode = async () => {
    setBusy(true);
    setError(null);
    const result = await send<{ resendAfter: number }>('auth/otp', {
      phone,
      dialCode,
      purpose: 'signup',
      locale,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    setResendAt(Date.now() + result.data.resendAfter * 1000);
    setStep(1);
    return true;
  };

  const onProfile = async (event: FormEvent) => {
    event.preventDefault();
    const next = { name: !firstName.trim() || !lastName.trim(), terms: !terms };
    setMissing(next);
    if (next.name || next.terms) return;
    await requestCode();
  };

  const onCode = async (code: string) => {
    setBusy(true);
    setError(null);
    setResent(false);
    const result = await send<MeResponse>('auth/signup', {
      phone,
      dialCode,
      code,
      firstName,
      lastName,
      email: email.trim(),
      acceptTerms: true,
      locale,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setMe(result.data);
    setStep(2);
  };

  const legalLink = (href: '/terms' | '/privacy', chunks: ReactNode) => (
    <a href={getPathname({ href, locale })} target="_blank" rel="noopener">
      {chunks}
    </a>
  );

  return (
    <AuthPageLayout brand={brand} barEnd={barEnd} side={<SignupSteps step={step} />}>
      <AuthHeading
        title={t('signup.title')}
        subtitle={t('signup.stepOf', { current: step + 1, total: 3, name: stepNames[step]! })}
      />
      <div className={styles.form}>
        {step === 0 && (
          <form onSubmit={onProfile} noValidate className={styles.form}>
            <AuthCard>
              <div className={styles.row}>
                <TextField
                  label={t('fields.firstName')}
                  autoComplete="given-name"
                  maxLength={60}
                  value={firstName}
                  onChange={(event) => setFirstName(event.target.value)}
                  error={missing.name && !firstName.trim() ? t('signup.nameRequired') : undefined}
                  required
                />
                <TextField
                  label={t('fields.lastName')}
                  autoComplete="family-name"
                  maxLength={60}
                  value={lastName}
                  onChange={(event) => setLastName(event.target.value)}
                  error={missing.name && !lastName.trim() ? t('signup.nameRequired') : undefined}
                  required
                />
              </div>
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
              <TextField
                label={t('fields.email')}
                optionalLabel={t('fields.optional')}
                type="email"
                autoComplete="email"
                placeholder={t('fields.emailPlaceholder')}
                help={t('signup.emailHelp')}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </AuthCard>
            <Checkbox
              checked={terms}
              onChange={(event) => setTerms(event.target.checked)}
              invalid={missing.terms && !terms}
              required
            >
              {t.rich('signup.terms', {
                terms: (chunks) => legalLink('/terms', chunks),
                privacy: (chunks) => legalLink('/privacy', chunks),
              })}
            </Checkbox>
            {missing.terms && !terms && <Alert tone="error">{t('signup.termsRequired')}</Alert>}
            {captchaRequired && <CaptchaNotice state={captchaState} />}
            <div className={styles.submitRow}>
              <Button type="submit" size="large" busy={busy}>
                {busy ? t('login.sendingCode') : t('signup.sendCode')}
              </Button>
              <span className={styles.muted}>{t('signup.free')}</span>
            </div>
          </form>
        )}

        {step === 1 && (
          <AuthCard>
            <p className={styles.text}>{t('signup.verifySubtitle')}</p>
            <CodeStep
              phone={formatPhone(normalizePhone(phone, dialCode) ?? `+${dialCode} ${phone}`)}
              length={config.otpLength}
              resendAt={resendAt}
              submitLabel={t('signup.create')}
              busyLabel={t('signup.creating')}
              busy={busy}
              error={error ? message(error) : undefined}
              notice={
                <>
                  {captchaRequired && <CaptchaNotice state={captchaState} />}
                  {resent && <Alert tone="success">{t('code.resent')}</Alert>}
                </>
              }
              onSubmit={onCode}
              onResend={async () => {
                setResent(false);
                if (await requestCode()) setResent(true);
              }}
              onChangeNumber={() => {
                setStep(0);
                setError(null);
              }}
            />
          </AuthCard>
        )}

        {step === 2 && me && (
          <AuthCard>
            <Alert tone="success">
              <strong>{t('signup.readyTitle')}</strong>
              <span>{t('signup.readyText', { name: me.user.displayName })}</span>
            </Alert>
            {me.user.pendingEmail && (
              <p className={styles.text}>
                {t('signup.emailSent', { email: me.user.pendingEmail })}
              </p>
            )}
            <div>
              <ButtonLink
                href={getPathname({ href: me.currentSpaceId ? '/app' : '/spaces', locale })}
                size="large"
                arrow
                onClick={(event) => {
                  event.preventDefault();
                  router.replace(me.currentSpaceId ? '/app' : '/spaces');
                  router.refresh();
                }}
              >
                {t('signup.open')}
              </ButtonLink>
            </div>
          </AuthCard>
        )}
      </div>
    </AuthPageLayout>
  );
}

/** Side column of the sign-up screen: the three steps. */
function SignupSteps({ step }: { step: number }) {
  const t = useTranslations('Auth.signup');
  return (
    <AuthSideSection title={t('steps')}>
      <Steps
        label={t('steps')}
        steps={[t('stepProfile'), t('stepVerify'), t('stepReady')]}
        current={step}
        doneLabel={t('stepDone')}
        currentLabel={t('stepCurrent')}
      />
    </AuthSideSection>
  );
}
