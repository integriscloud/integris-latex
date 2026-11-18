'use client';

import {
  AUTH_ERROR_CODES,
  type AuthErrorCode,
  type CaptchaAction,
  type CaptchaChallengeRequest,
} from '@integris/shared';
import type { CaptchaState } from '@integris/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';
import { apiPost, type ApiResult, type ClientError } from '../../lib/api-client';
import { solveCaptcha } from '../../lib/captcha';

const AUTH_MESSAGES: readonly string[] = [...AUTH_ERROR_CODES, 'network', 'unknown'];
const authCode = (error: ClientError) =>
  (AUTH_MESSAGES.includes(error.code) ? error.code : 'unknown') as
    AuthErrorCode | 'network' | 'unknown';

const isCaptchaError = (error: ClientError) =>
  error.code === 'captcha_required' || error.code === 'captcha_invalid';

/** Translated message of an API error (with the waiting time when there is one). */
export function useErrorMessage() {
  const t = useTranslations('Auth.errors');
  return useCallback(
    (error: ClientError) =>
      t(authCode(error), { minutes: Math.max(1, Math.ceil((error.retryAfter ?? 60) / 60)) }),
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

  const captcha = useCallback(async (target: CaptchaChallengeRequest) => {
    setCaptchaState('solving');
    const payload = await solveCaptcha(target).catch(() => null);
    setCaptchaState(payload ? 'done' : 'error');
    return payload ?? undefined;
  }, []);

  const send = useCallback(
    async <T>(
      path: string,
      body: { phone?: string; dialCode?: string; email?: string; [key: string]: unknown },
      action: CaptchaAction,
    ): Promise<ApiResult<T>> => {
      // The challenge is signed for this action and this phone number or e-mail address.
      const target = { action, phone: body.phone, dialCode: body.dialCode, email: body.email };
      let token = captchaRequired ? await captcha(target) : undefined;
      let result = await apiPost<T>(path, { ...body, captcha: token });
      if (!result.ok && isCaptchaError(result.error) && !token) {
        setCaptchaRequired(true);
        token = await captcha(target);
        if (token) result = await apiPost<T>(path, { ...body, captcha: token });
      }
      return result;
    },
    [captcha, captchaRequired],
  );

  return { send, captchaRequired, captchaState };
}
