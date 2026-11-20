'use client';

import {
  PROJECT_ERROR_CODES,
  type ProjectErrorCode,
  SHARING_ERROR_CODES,
  type SharingErrorCode,
  SUBMISSION_ERROR_CODES,
  type SubmissionErrorCode,
} from '@integris/shared';
import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import type { ClientError } from '../../lib/api-client';
import { formatBytes } from '../../lib/format';
import { useErrorMessage } from '../auth/use-auth-request';

const PROJECT_CODES: readonly string[] = [
  ...PROJECT_ERROR_CODES,
  ...SHARING_ERROR_CODES,
  ...SUBMISSION_ERROR_CODES,
];

const isProjectError = (
  code: string,
): code is ProjectErrorCode | SharingErrorCode | SubmissionErrorCode =>
  PROJECT_CODES.includes(code);

/**
 * Translated message of an error of the project, file, template, sharing, comment or submission
 * endpoints.
 */
export function useApiErrorMessage(locale: string) {
  const t = useTranslations('ProjectErrors');
  const authMessage = useErrorMessage();
  return useCallback(
    (error: ClientError, limits?: { maxFileBytes?: number; maxArchiveBytes?: number }) =>
      isProjectError(error.code)
        ? t(error.code, {
            maxFile: formatBytes(limits?.maxFileBytes ?? 0, locale),
            maxArchive: formatBytes(limits?.maxArchiveBytes ?? 0, locale),
            minutes: Math.max(1, Math.ceil((error.retryAfter ?? 60) / 60)),
          })
        : authMessage(error),
    [t, authMessage, locale],
  );
}
