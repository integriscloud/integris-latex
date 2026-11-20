'use client';

import type { SubmissionDetail, SubmissionEvent } from '@integris/shared';
import {
  Alert,
  Button,
  ButtonLink,
  EmptyState,
  PageHeader,
  Panel,
  SubmissionStatusBadge,
} from '@integris/ui';
import { ArrowLeft, FileText } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { getPathname } from '../../i18n/navigation';
import type { ApiResult } from '../../lib/api-client';
import {
  loadSubmission,
  setSubmissionDue,
  submissionAction,
  validateSubmission,
} from '../../lib/submissions/api';
import { ConfirmDialog } from '../app/dialogs';
import appStyles from '../app/app.module.css';
import { useApiErrorMessage } from '../app/use-api-error';
import { PdfViewer } from '../editor/PdfViewer';
import { DueDateField, useDueInput } from './DueDateField';
import styles from './submissions.module.css';

const POLL_MS = 3000;
/** Signed PDF links are asked again this long before they expire. */
const RENEW_BEFORE_MS = 60_000;

type Confirm = 'feedback' | 'validate' | 'unlock' | null;

/** Time left before asking again for the PDF links that expire at `expiresAt`. */
const renewDelay = (expiresAt: string) =>
  Math.max(5000, Date.parse(expiresAt) - Date.now() - RENEW_BEFORE_MS);

/**
 * Review page of a submission (mockup professeur-02): the PDF of the version sent (never the
 * project's last PDF), the files and their fingerprints, the message, the reviewers, the thread,
 * and the decision of the reviewers: feedback, validation (supervisors only), unlocking and
 * deadline. Opened by a reviewer, a submission just received moves to "in review".
 */
export function SubmissionView({ initial }: { initial: SubmissionDetail }) {
  const t = useTranslations('Submissions');
  const te = useTranslations('Editor');
  const locale = useLocale();
  const format = useFormatter();
  const errorMessage = useApiErrorMessage(locale);
  const [detail, setDetail] = useState(initial);
  const [number, setNumber] = useState<number | null>(initial.lastNumber);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const due = useDueInput(initial.dueAt);
  const [dueInvalid, setDueInvalid] = useState(false);
  const [dueBusy, setDueBusy] = useState(false);
  const [dueSaved, setDueSaved] = useState(false);
  const [reads, setReads] = useState(0);

  const projectId = detail.projectId;
  const when = useCallback(
    (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' }),
    [format],
  );

  const apply = useCallback((result: ApiResult<SubmissionDetail>) => {
    if (!result.ok) return false;
    setDetail(result.data);
    setNumber((current) =>
      current === null || !result.data.versions.some((v) => v.number === current)
        ? result.data.lastNumber
        : current,
    );
    return true;
  }, []);

  // A reviewer opening the page: in review (once), and the time of their reading is kept.
  useEffect(() => {
    if (!initial.isReviewer) return;
    void submissionAction(initial.projectId, initial.id, 'open').then((result) => {
      if (result.ok) setDetail(result.data);
    });
  }, [initial.isReviewer, initial.projectId, initial.id]);

  // Read again while a sending is compiled, and before the PDF links expire.
  const shown = detail.versions.find((version) => version.number === number) ?? null;
  const expiresAt = shown?.compilation?.pdf?.expiresAt;
  useEffect(() => {
    const delay = detail.sending ? POLL_MS : expiresAt ? renewDelay(expiresAt) : null;
    if (delay === null) return;
    const timer = setTimeout(() => {
      void loadSubmission(projectId, detail.id).then((result) => {
        apply(result);
        setReads((value) => value + 1);
      });
    }, delay);
    return () => clearTimeout(timer);
  }, [detail.sending, detail.id, expiresAt, projectId, apply, reads]);

  const act = async (run: () => Promise<ApiResult<SubmissionDetail>>) => {
    const result = await run();
    if (!result.ok) return errorMessage(result.error);
    apply(result);
    setError(null);
    return null;
  };

  const saveDue = async (value: string | null) => {
    setDueBusy(true);
    setDueSaved(false);
    const message = await act(() => setSubmissionDue(projectId, detail.id, value));
    setDueBusy(false);
    if (message) setError(message);
    else setDueSaved(true);
  };

  const projectHref = getPathname({ href: `/app/projects/${projectId}`, locale });
  const editorHref = getPathname({ href: `/app/projects/${projectId}/edit`, locale });
  const compareHref = (from: number, to: number) =>
    `${getPathname({
      href: `/app/projects/${projectId}/submissions/${detail.id}/compare`,
      locale,
    })}?from=${from}&to=${to}`;

  const ready = detail.versions.filter((version) => version.state === 'READY');
  const title = detail.title ?? t('untitled');
  const last = detail.lastNumber;
  const validated = [...detail.events]
    .reverse()
    .find((event) => event.action === 'SUBMISSION_VALIDATED');

  const eventText = (event: SubmissionEvent) => {
    const actor = event.actor?.name ?? t('event.someone');
    if (event.action === 'SUBMISSION_DUE_CHANGED') {
      return event.dueAt
        ? t('event.SUBMISSION_DUE_CHANGED', { actor, date: when(event.dueAt) })
        : t('event.dueRemoved', { actor });
    }
    return t(`event.${event.action}`, { actor, number: event.number ?? 0 });
  };

  const pdf = shown?.compilation?.pdf;

  return (
    <>
      <PageHeader
        back={
          <a className={appStyles.back} href={projectHref}>
            <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
            {detail.projectName}
          </a>
        }
        title={title}
        subtitle={
          <span className={styles.row}>
            <SubmissionStatusBadge status={detail.status} label={t(`status.${detail.status}`)} />
            <span>
              {detail.author.name}
              {detail.receivedAt && ` · ${t('received', { date: when(detail.receivedAt) })}`}
              {' · '}
              {detail.dueAt ? t('due', { date: when(detail.dueAt) }) : t('noDue')}
            </span>
          </span>
        }
        actions={
          <>
            {last !== null && last > 1 && (
              <ButtonLink href={compareHref(last - 1, last)} variant="secondary">
                {t('compare')}
              </ButtonLink>
            )}
            <ButtonLink href={editorHref} variant="secondary">
              {t('openEditor')}
            </ButtonLink>
          </>
        }
      />

      {error && <Alert tone="error">{error}</Alert>}
      {detail.sending && <Alert tone="info">{t('pdfPending')}</Alert>}
      {detail.status === 'VALIDATED' && detail.validatedAt && (
        <Alert tone="success">
          {t('validatedNotice', {
            number: detail.validatedNumber ?? 0,
            date: when(detail.validatedAt),
            name: detail.validatedBy?.name ?? '',
          })}
        </Alert>
      )}
      {!detail.isReviewer && validated && validated.restored.length > 0 && (
        <Alert tone="info">
          {t('restoredNotice', { label: validated.beforeVersionLabel ?? '' })}
        </Alert>
      )}
      {detail.unlockedAt && (
        <Alert tone="info">
          {t('unlockedNotice', {
            date: when(detail.unlockedAt),
            name: detail.unlockedBy?.name ?? '',
          })}
        </Alert>
      )}
      {!detail.isReviewer && detail.status === 'FEEDBACK_SENT' && (
        <Alert tone="warning">{t('feedbackNotice')}</Alert>
      )}

      <div className={styles.page}>
        <section className={styles.pdf} aria-label={t('pdfTitle', { number: number ?? 0 })}>
          <div className={styles.pdfHead}>
            <strong>{number ? t('pdfTitle', { number }) : t('versions')}</strong>
            {ready.length > 1 && (
              <label className={styles.row}>
                <span className={styles.label}>{t('versionChoice')}</span>
                <select
                  className={styles.select}
                  value={number ?? ''}
                  onChange={(event) => setNumber(Number(event.target.value))}
                >
                  {ready.map((version) => (
                    <option key={version.id} value={version.number ?? 0}>
                      {t('versionLong', { number: version.number ?? 0 })}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div className={styles.pdfBody}>
            {pdf && shown?.compilation ? (
              <PdfViewer
                documentKey={shown.compilation.id}
                url={pdf.url}
                downloadUrl={pdf.downloadUrl}
                highlight={null}
                labels={{
                  toolbar: te('pdfViewer.toolbar'),
                  previous: te('pdfViewer.previous'),
                  next: te('pdfViewer.next'),
                  page: (page, pages) => te('pdfViewer.page', { page, pages }),
                  pageLabel: (page) => te('pdfViewer.pageLabel', { page }),
                  zoomIn: te('pdfViewer.zoomIn'),
                  zoomOut: te('pdfViewer.zoomOut'),
                  fit: te('pdfViewer.fit'),
                  download: te('pdfViewer.download'),
                  loading: te('pdfViewer.loading'),
                  failed: te('pdfViewer.failed'),
                  retry: te('retry'),
                }}
              />
            ) : (
              <div className={styles.placeholder}>
                <EmptyState
                  icon={FileText}
                  title={detail.sending || !shown ? t('pdfPending') : t('pdfMissing')}
                />
              </div>
            )}
          </div>
        </section>

        <div className={styles.aside}>
          {detail.isReviewer && (
            <Panel title={t('decision')}>
              <div className={styles.decision}>
                {detail.can.validate && detail.changedSinceSent.length > 0 && (
                  <Alert tone="warning">
                    <p>
                      {t('changedSinceSent', { number: last ?? 0 })}{' '}
                      {t('changedFiles', { files: detail.changedSinceSent.join(', ') })}
                    </p>
                  </Alert>
                )}
                {detail.can.validate && last !== null && (
                  <>
                    <Button onClick={() => setConfirm('validate')}>
                      {t('validate', { number: last })}
                    </Button>
                    <p className={styles.help}>{t('validateHelp')}</p>
                  </>
                )}
                {detail.can.feedback && (
                  <>
                    <Button variant="secondary" onClick={() => setConfirm('feedback')}>
                      {t('feedback')}
                    </Button>
                    <p className={styles.help}>{t('feedbackHelp')}</p>
                  </>
                )}
                {detail.can.unlock && (
                  <>
                    <Button variant="secondary" onClick={() => setConfirm('unlock')}>
                      {t('unlock')}
                    </Button>
                    <p className={styles.help}>{t('unlockHelp')}</p>
                  </>
                )}
                <p className={styles.help}>{t('commentHint')}</p>
              </div>
            </Panel>
          )}

          {detail.can.setDue && (
            <Panel title={t('dueTitle')}>
              <form
                className={styles.form}
                onSubmit={(event) => {
                  event.preventDefault();
                  const value = due.read();
                  setDueInvalid(value === 'invalid' || value === null);
                  if (value !== 'invalid' && value !== null) void saveDue(value);
                }}
              >
                <DueDateField
                  legend={t('dueLabel')}
                  value={due.input}
                  onChange={(value) => {
                    due.setInput(value);
                    setDueSaved(false);
                    setDueInvalid(false);
                  }}
                  invalid={dueInvalid}
                />
                {dueSaved && <Alert tone="success">{t('dueSaved')}</Alert>}
                <div className={styles.actions}>
                  <Button type="submit" busy={dueBusy} disabled={!due.input.date.trim()}>
                    {t('dueSave')}
                  </Button>
                  {detail.dueAt && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        due.clear();
                        void saveDue(null);
                      }}
                    >
                      {t('dueClear')}
                    </Button>
                  )}
                </div>
              </form>
            </Panel>
          )}

          {shown && (
            <Panel title={t('files')}>
              <ul className={styles.files}>
                {shown.files.map((file) => (
                  <li key={file.path}>
                    <span className={styles.path}>{file.path}</span>
                  </li>
                ))}
              </ul>
              <details className={styles.details}>
                <summary className={styles.summary}>{t('technicalDetails')}</summary>
                <p className={styles.help}>{t('technicalHelp')}</p>
                <ul className={styles.files}>
                  {shown.files.map((file) => (
                    <li key={file.path}>
                      <span className={styles.path}>{file.path}</span>
                      <span className={styles.hash}>{t('fingerprint', { hash: file.sha256 })}</span>
                    </li>
                  ))}
                </ul>
              </details>
              <h3 className={styles.subheading}>{t('message')}</h3>
              <p className={styles.messageText}>{shown.message ?? t('noMessage')}</p>
              <p className={styles.meta}>
                {t('versionSent', {
                  date: when(shown.readyAt ?? shown.createdAt),
                  name: shown.sentBy.name,
                })}
              </p>
            </Panel>
          )}

          <Panel title={t('reviewersTitle')}>
            <ul className={styles.files}>
              {detail.reviewerDetails.map((reviewer) => (
                <li key={reviewer.id}>
                  <span className={styles.row}>
                    <strong>{reviewer.name}</strong>
                    {reviewer.role === 'SUPERVISOR' || reviewer.role === 'REVIEWER' ? (
                      <span className={styles.meta}>{t(`form.role.${reviewer.role}`)}</span>
                    ) : null}
                  </span>
                  <span className={styles.meta}>
                    {reviewer.role !== 'SUPERVISOR' && reviewer.role !== 'REVIEWER'
                      ? t('reviewerGone')
                      : reviewer.lastReviewedAt
                        ? t('reviewerRead', { date: when(reviewer.lastReviewedAt) })
                        : t('reviewerUnread')}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title={t('thread')}>
            {detail.events.length === 0 ? (
              <p className={styles.meta}>{t('threadEmpty')}</p>
            ) : (
              <ol className={styles.thread}>
                {detail.events.map((event, index) => (
                  <li key={index}>
                    <span className={styles.threadText}>{eventText(event)}</span>
                    <span className={styles.threadDate}>{when(event.at)}</span>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>
      </div>

      <ConfirmDialog
        open={confirm === 'feedback'}
        title={t('feedbackTitle')}
        text={t('feedbackText')}
        confirmLabel={t('feedback')}
        onConfirm={() => act(() => submissionAction(projectId, detail.id, 'feedback'))}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'validate'}
        title={t('validateTitle', { number: last ?? 0 })}
        text={t('validateText')}
        warning={
          detail.changedSinceSent.length > 0
            ? t('changedSinceSent', { number: last ?? 0 })
            : undefined
        }
        confirmLabel={t('validate', { number: last ?? 0 })}
        onConfirm={() => act(() => validateSubmission(projectId, detail.id, last ?? 0))}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'unlock'}
        title={t('unlockTitle')}
        text={t('unlockText')}
        confirmLabel={t('unlock')}
        onConfirm={() => act(() => submissionAction(projectId, detail.id, 'unlock'))}
        onClose={() => setConfirm(null)}
      />
    </>
  );
}
