'use client';

import { BILLING_ERROR_CODES } from '@integris/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback } from 'react';
import type { ClientError } from '../../lib/api-client';
import { useApiErrorMessage } from '../app/use-api-error';

type BillingErrorCode = (typeof BILLING_ERROR_CODES)[number];

const isBillingError = (code: string): code is BillingErrorCode =>
  (BILLING_ERROR_CODES as readonly string[]).includes(code);

/** Translated message of an error of the billing endpoints (others: projects, then auth). */
export function useBillingError() {
  const t = useTranslations('BillingErrors');
  const locale = useLocale();
  const fallback = useApiErrorMessage(locale);
  return useCallback(
    (error: ClientError) => (isBillingError(error.code) ? t(error.code) : fallback(error)),
    [t, fallback],
  );
}
