'use client';

import { ADMIN_ERROR_CODES, BILLING_ERROR_CODES, EXAM_ERROR_CODES } from '@integris/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback } from 'react';
import type { ClientError } from '../../lib/api-client';
import { useApiErrorMessage } from '../app/use-api-error';

const ADMIN_CODES: readonly string[] = ADMIN_ERROR_CODES;
const BILLING_CODES: readonly string[] = BILLING_ERROR_CODES;
const EXAM_CODES: readonly string[] = EXAM_ERROR_CODES;

/** Translated message of an error of the back-office (its own codes, then the shared ones). */
export function useAdminErrorMessage() {
  const t = useTranslations('AdminErrors');
  const tb = useTranslations('BillingErrors');
  const te = useTranslations('ExamErrors');
  const fallback = useApiErrorMessage(useLocale());
  return useCallback(
    (error: ClientError) => {
      if (ADMIN_CODES.includes(error.code)) return t(error.code as 'admin_not_found');
      if (BILLING_CODES.includes(error.code)) return tb(error.code as 'payment_not_found');
      if (EXAM_CODES.includes(error.code)) return te(error.code as 'template_empty');
      return fallback(error);
    },
    [t, tb, te, fallback],
  );
}
