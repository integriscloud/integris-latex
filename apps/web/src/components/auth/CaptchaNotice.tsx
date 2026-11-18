'use client';

import { CaptchaBox, type CaptchaState } from '@integris/ui';
import { useTranslations } from 'next-intl';

/** Shown once the API requires the anti-robot check. */
export function CaptchaNotice({ state }: { state: CaptchaState }) {
  const t = useTranslations('Auth.captcha');
  const label = state === 'done' ? t('done') : state === 'error' ? t('error') : t('solving');
  return <CaptchaBox title={t('title')} text={t('text')} state={state} stateLabel={label} />;
}
