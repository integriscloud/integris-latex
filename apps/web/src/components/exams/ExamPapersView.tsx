'use client';

import type { ExamPaperList, ProjectSummary } from '@integris/shared';
import { Alert, Badge, Button, ButtonLink, EmptyState, Panel, TextField } from '@integris/ui';
import { ClipboardList, Loader } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { getPathname } from '../../i18n/navigation';
import { apiPost, type ClientError } from '../../lib/api-client';
import styles from './exams.module.css';
import { PrintBadge, useExamErrorMessage } from './print-shared';

/**
 * "Mes devoirs" (BUSINESS teachers): the exam papers the user owns or co-edits, with the status
 * of their current print request, and the creation of a new one (subject, answer key and
 * marking scheme). No mockup of the list: built from the existing components.
 */
export function ExamPapersView({ data }: { data: ExamPaperList }) {
  const t = useTranslations('Exams');
  const locale = useLocale();
  const format = useFormatter();
  const errorMessage = useExamErrorMessage();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);

  const paperHref = (id: string) => getPathname({ href: `/app/exams/${id}`, locale });

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    const result = await apiPost<ProjectSummary>('exam-papers', { name: name.trim() });
    if (!result.ok) {
      setBusy(false);
      setError(result.error);
      return;
    }
    // A full load: the editor is another root layout.
    window.location.assign(getPathname({ href: `/app/projects/${result.data.id}/edit`, locale }));
  };

  return (
    <div className={styles.stack}>
      {data.canCreate && (
        <Panel title={t('create.title')}>
          <form className={styles.form} onSubmit={create}>
            <p className={styles.muted}>{t('create.help')}</p>
            <div className={styles.inline}>
              <TextField
                label={t('create.name')}
                placeholder={t('create.placeholder')}
                value={name}
                maxLength={120}
                required
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            {error && (
              <Alert tone="error">
                <p>{errorMessage(error)}</p>
              </Alert>
            )}
            <div className={styles.actions}>
              <Button type="submit" busy={busy}>
                {t('create.submit')}
              </Button>
            </div>
          </form>
        </Panel>
      )}

      <Panel title={t('list.title', { count: data.papers.length })}>
        {data.papers.length ? (
          <ul className={styles.list}>
            {data.papers.map((paper) => (
              <li key={paper.id} className={styles.card}>
                <div className={styles.who}>
                  <div className={styles.badges}>
                    <p className={styles.name}>{paper.name}</p>
                    {paper.role === 'EDITOR' && (
                      <Badge tone="neutral">{t('list.coedited', { name: paper.ownerName })}</Badge>
                    )}
                    {paper.sending && (
                      <Badge tone="info" icon={Loader}>
                        {t('list.sending')}
                      </Badge>
                    )}
                    {paper.current && <PrintBadge status={paper.current.status} />}
                  </div>
                  <p className={styles.muted}>
                    {paper.current
                      ? t('list.current', {
                          group: paper.current.groupName,
                          date: format.dateTime(new Date(paper.current.examAt), {
                            dateStyle: 'medium',
                          }),
                        })
                      : t('list.notSent')}
                    {' · '}
                    {t('list.activity', {
                      date: format.dateTime(new Date(paper.lastActivityAt), {
                        dateStyle: 'medium',
                      }),
                    })}
                  </p>
                </div>
                <div className={styles.actions}>
                  <ButtonLink
                    variant="secondary"
                    href={getPathname({ href: `/app/projects/${paper.id}/edit`, locale })}
                  >
                    {t('list.write')}
                  </ButtonLink>
                  <ButtonLink href={paperHref(paper.id)}>{t('list.open')}</ButtonLink>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={ClipboardList}
            title={t('list.empty')}
            text={data.canCreate ? t('list.emptyHelp') : t('list.cannotCreate')}
          />
        )}
      </Panel>
    </div>
  );
}
