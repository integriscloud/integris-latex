'use client';

import type { CaptchaState } from '@integris/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';
import { apiPost, type ApiResult, type ClientError } from '../../lib/api-client';
import { solveCaptcha } from '../../lib/captcha';

const isCaptchaError = (error: ClientError) =>
  error.code === 'captcha_required' || error.code === 'captcha_invalid';

/** Translated message of an API error (with the waiting time when there is one). */
export function useErrorMessage() {
  const t = useTranslations('Auth.errors');
  return useCallback(
    (error: ClientError) =>
      t(error.code, { minutes: Math.max(1, Math.ceil((error.retryAfter ?? 60) / 60)) }),
    [t],
  );
}

/**
 * Sends auth requests and handles the CAPTCHA: once the API asks for one, every request first
 * solves a fresh challenge, and the request that was refused is sent again automatically.
 */
export function useAuthRequest() {
  const [captchaRequired, setCaptchaRequired] = useState(false);
  const [captchaState, setCaptchaState] = useState<CaptchaState>('solving');

  const captcha = useCallback(async (): Promise<string | undefined> => {
    setCaptchaState('solving');
    const payload = await solveCaptcha().catch(() => null);
    setCaptchaState(payload ? 'done' : 'error');
    return payload ?? undefined;
  }, []);

  const send = useCallback(
    async <T>(path: string, body: object): Promise<ApiResult<T>> => {
      let token = captchaRequired ? await captcha() : undefined;
      let result = await apiPost<T>(path, { ...body, captcha: token });
      if (!result.ok && isCaptchaError(result.error) && !token) {
        setCaptchaRequired(true);
        token = await captcha();
        if (token) result = await apiPost<T>(path, { ...body, captcha: token });
      }
      return result;
    },
    [captcha, captchaRequired],
  );

  return { send, captchaRequired, captchaState };
}
