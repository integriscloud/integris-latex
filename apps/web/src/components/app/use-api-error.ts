'use client';

import { PROJECT_ERROR_CODES, type ProjectErrorCode } from '@integris/shared';
import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import type { ClientError } from '../../lib/api-client';
import { formatBytes } from '../../lib/format';
import { useErrorMessage } from '../auth/use-auth-request';

const isProjectError = (code: string): code is ProjectErrorCode =>
  (PROJECT_ERROR_CODES as readonly string[]).includes(code);

/** Translated message of an error of the project, file or template endpoints. */
export function useApiErrorMessage(locale: string) {
  const t = useTranslations('ProjectErrors');
  const authMessage = useErrorMessage();
  return useCallback(
    (error: ClientError, limits?: { maxFileBytes?: number; maxArchiveBytes?: number }) =>
      isProjectError(error.code)
        ? t(error.code, {
            maxFile: formatBytes(limits?.maxFileBytes ?? 0, locale),
            maxArchive: formatBytes(limits?.maxArchiveBytes ?? 0, locale),
          })
        : authMessage(error),
    [t, authMessage, locale],
  );
}
