'use client';

import { ORG_ERROR_CODES, type OrgErrorCode } from '@integris/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback } from 'react';
import type { ClientError } from '../../lib/api-client';
import { useApiErrorMessage } from '../app/use-api-error';

const isOrgError = (code: string): code is OrgErrorCode =>
  (ORG_ERROR_CODES as readonly string[]).includes(code);

/** Translated message of an error of the organization, import, group or supervision endpoints. */
export function useOrgErrorMessage() {
  const t = useTranslations('OrgErrors');
  const locale = useLocale();
  const fallback = useApiErrorMessage(locale);
  return useCallback(
    (error: ClientError) => (isOrgError(error.code) ? t(error.code) : fallback(error)),
    [t, fallback],
  );
}
