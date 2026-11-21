'use client';

import type { SupervisionDashboard } from '@integris/shared';
import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  Panel,
  SubmissionStatusBadge,
} from '@integris/ui';
import { GraduationCap } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { getPathname, useRouter } from '../../i18n/navigation';
import { apiPost, type ClientError } from '../../lib/api-client';
import styles from './org.module.css';
import { useOrgErrorMessage } from './use-org-error';

/**
 * Supervision dashboard of a teacher (BUSINESS, mockup professeur-01 "Avancement de vos
 * étudiants", rebuilt plain): one row per project a followed student opened, sorted by urgency
 * (overdue, to review, due soon, oldest activity); students' requests to accept or decline.
 */
export function SupervisionDashboardView({ data }: { data: SupervisionDashboard }) {
  const t = useTranslations('SupervisionDashboard');
  const tSub = useTranslations('Submissions');
  const locale = useLocale();
  const format = useFormatter();
  const router = useRouter();
  const errorMessage = useOrgErrorMessage();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const now = new Date();

  const answer = async (id: string, accept: boolean) => {
    setBusy(id);
    setError(null);
    const result = await apiPost(`supervisions/${id}/${accept ? 'accept' : 'decline'}`);
    setBusy(null);
    if (!result.ok) setError(result.error);
    else router.refresh();
  };

  const day = (iso: string) => format.dateTime(new Date(iso), { day: 'numeric', month: 'long' });

  return (
    <div className={styles.stack}>
      <p className={styles.muted}>
        {data.maxStudents
          ? t('count', { count: data.students, max: data.maxStudents })
          : t('countUnlimited', { count: data.students })}
      </p>
      {error && (
        <Alert tone="error">
          <p>{errorMessage(error)}</p>
        </Alert>
      )}
      {data.requests.length > 0 && (
        <Panel title={t('requests.title', { count: data.requests.length })}>
          <ul className={styles.list}>
            {data.requests.map((request) => (
              <li key={request.id} className={styles.item}>
                <div className={styles.who}>
                  <p className={styles.name}>{request.student.name}</p>
                  <p className={styles.muted}>
                    {[request.student.group, t('requests.since', { date: day(request.createdAt) })]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                <div className={styles.actions}>
                  <Button
                    variant="secondary"
                    busy={busy === request.id}
                    onClick={() => void answer(request.id, false)}
                  >
                    {t('requests.decline')}
                  </Button>
                  <Button busy={busy === request.id} onClick={() => void answer(request.id, true)}>
                    {t('requests.accept')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {data.rows.length === 0 ? (
        <EmptyState icon={GraduationCap} title={t('empty.title')} text={t('empty.text')} />
      ) : (
        <ul className={styles.rows} aria-label={t('rowsLabel')}>
          {data.rows.map((row) => (
            <li
              key={`${row.supervisionId}-${row.project?.id ?? 'none'}`}
              className={`${styles.row} ${row.urgency === 'overdue' ? styles.overdue : ''}`}
            >
              <div className={styles.who}>
                <p className={styles.name}>{row.student.name}</p>
                <p className={styles.muted}>
                  {[row.student.group, row.project?.name ?? t('noProject')]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                <div className={styles.badges}>
                  {row.urgency !== 'none' && (
                    <Badge tone={row.urgency === 'overdue' ? 'danger' : 'warning'}>
                      {t(`urgency.${row.urgency}`)}
                    </Badge>
                  )}
                  {row.submission && (
                    <SubmissionStatusBadge
                      status={row.submission.status}
                      label={tSub(`status.${row.submission.status}`)}
                    />
                  )}
                </div>
                <p className={styles.muted}>
                  {[
                    row.submission?.title,
                    row.submission?.dueAt ? t('due', { date: day(row.submission.dueAt) }) : null,
                    t('submissions', { count: row.submissions }),
                    row.lastActivityAt
                      ? t('activity', {
                          when: format.relativeTime(new Date(row.lastActivityAt), now),
                        })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              {row.project && (
                <div className={styles.actions}>
                  {row.submission ? (
                    <ButtonLink
                      href={getPathname({
                        href: `/app/projects/${row.project.id}/submissions/${row.submission.id}`,
                        locale,
                      })}
                    >
                      {t('openSubmission')}
                    </ButtonLink>
                  ) : (
                    <ButtonLink
                      variant="secondary"
                      href={getPathname({ href: `/app/projects/${row.project.id}`, locale })}
                    >
                      {t('openProject')}
                    </ButtonLink>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
