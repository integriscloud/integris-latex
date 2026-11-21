'use client';

import type { ExamPaperDetail } from '@integris/shared';
import { Alert, ButtonLink } from '@integris/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { getPathname } from '../../i18n/navigation';
import { apiRead, type ClientError } from '../../lib/api-client';
import { ExamPaperView } from './ExamPaperView';
import styles from './exams.module.css';
import { useExamErrorMessage } from './print-shared';

/**
 * "Secrétariat" tab of the editor of an exam paper: the current request and the send form
 * (mockup professeur-03, right column); the full page has the co-editors and the journal.
 */
export function ExamPrintPanel({ projectId }: { projectId: string }) {
  const t = useTranslations('Exams');
  const locale = useLocale();
  const errorMessage = useExamErrorMessage();
  const [detail, setDetail] = useState<ExamPaperDetail | null>(null);
  const [error, setError] = useState<ClientError | null>(null);

  useEffect(() => {
    void apiRead<ExamPaperDetail>(`exam-papers/${projectId}`).then((result) => {
      if (result.ok) setDetail(result.data);
      else setError(result.error);
    });
  }, [projectId]);

  return (
    <div className={styles.stack}>
      {error && (
        <Alert tone="error">
          <p>{errorMessage(error)}</p>
        </Alert>
      )}
      {detail ? (
        <ExamPaperView initial={detail} compact />
      ) : (
        !error && <p className={styles.muted}>…</p>
      )}
      {/* A plain link: the exam paper page is under the other root layout. */}
      <ButtonLink
        variant="secondary"
        href={getPathname({ href: `/app/exams/${projectId}`, locale })}
      >
        {t('openPaper')}
      </ButtonLink>
    </div>
  );
}
