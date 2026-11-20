'use client';

import {
  API_PREFIX,
  type SubmissionDetail,
  type SubmissionList,
  type SubmissionSummary,
} from '@integris/shared';
import { Alert, Button, ButtonLink, EmptyState, SubmissionStatusBadge } from '@integris/ui';
import { ArrowLeft, FileCheck, Plus } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import type { ClientError } from '../../lib/api-client';
import {
  createSubmission,
  deleteSubmission,
  loadSubmission,
  loadSubmissions,
  sendSubmission,
  updateSubmission,
} from '../../lib/submissions/api';
import { ConfirmDialog } from '../app/dialogs';
import { useApiErrorMessage } from '../app/use-api-error';
import { SubmissionForm, type SubmissionValues } from './SubmissionForm';
import styles from './submissions.module.css';

/** While a sending is compiled, its result is asked again this often. */
const POLL_MS = 3000;

type View =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'detail'; id: string }
  | { kind: 'edit'; id: string }
  | { kind: 'send'; id: string };

export interface SubmissionsPanelProps {
  projectId: string;
  /** Paths of the project files. */
  paths: string[];
  /** Writes the open files to storage first (before freezing a version). */
  flush: () => Promise<boolean>;
  /** Address of the review page of a submission. */
  reviewHref: (id: string) => string;
}

/**
 * Submissions of the project in the editor (docs/spec.md, "Encadrement"): the owner and editors
 * prepare a draft, send it (the version sent is frozen and compiled, and goes out when its PDF is
 * ready), and send corrected versions after feedback. Reviewing, validating and comparing happen
 * on the review page.
 */
export function SubmissionsPanel({ projectId, paths, flush, reviewHref }: SubmissionsPanelProps) {
  const t = useTranslations('Submissions');
  const locale = useLocale();
  const format = useFormatter();
  const errorMessage = useApiErrorMessage(locale);
  const [list, setList] = useState<SubmissionList | null>(null);
  const [detail, setDetail] = useState<SubmissionDetail | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [attempt, setAttempt] = useState(0);
  // Increased to read the detail again (and poll a sending just made).
  const [reads, setReads] = useState(0);
  const [deleting, setDeleting] = useState(false);

  const when = useCallback(
    (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' }),
    [format],
  );
  const refresh = () => setAttempt((value) => value + 1);
  const detailId = view.kind === 'list' || view.kind === 'create' ? null : view.id;

  useEffect(() => {
    let cancelled = false;
    void loadSubmissions(projectId).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setList(result.data);
        setError(null);
      } else setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, attempt]);

  useEffect(() => {
    if (!detailId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = async () => {
      const result = await loadSubmission(projectId, detailId);
      if (cancelled) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDetail(result.data);
      // The sending goes out (or is refused) when its compilation ends.
      if (result.data.sending) timer = setTimeout(() => void read(), POLL_MS);
      else setAttempt((value) => value + 1);
    };
    void read();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [projectId, detailId, reads]);

  const show = (next: View, data?: SubmissionDetail) => {
    if (data) setDetail(data);
    setView(next);
    refresh();
  };

  const statusLabel = (status: SubmissionSummary['status']) => t(`status.${status}`);
  const titleOf = (item: { title: string | null }) => item.title ?? t('untitled');

  const create = async (values: SubmissionValues) => {
    const result = await createSubmission(projectId, values);
    if (!result.ok) return errorMessage(result.error);
    show({ kind: 'detail', id: result.data.id }, result.data);
    return null;
  };

  const save = async (id: string, values: SubmissionValues) => {
    const result = await updateSubmission(projectId, id, values);
    if (!result.ok) return errorMessage(result.error);
    show({ kind: 'detail', id }, result.data);
    return null;
  };

  const send = async (id: string, values: SubmissionValues) => {
    // The version frozen holds what is typed now.
    if (!(await flush())) return t('flushFailed');
    const result = await sendSubmission(projectId, id, {
      filePaths: values.filePaths,
      message: values.message,
    });
    if (!result.ok) return errorMessage(result.error);
    setDetail(result.data);
    setView({ kind: 'detail', id });
    // Reading the detail again polls the compilation of the sending.
    setReads((value) => value + 1);
    return null;
  };

  const remove = async () => {
    if (!detail) return null;
    const result = await deleteSubmission(projectId, detail.id);
    if (!result.ok) return errorMessage(result.error);
    show({ kind: 'list' });
    return null;
  };

  if (error && !list) {
    return (
      <div className={styles.panel}>
        <Alert tone="error">{errorMessage(error)}</Alert>
        <Button variant="secondary" onClick={refresh}>
          {t('retry')}
        </Button>
      </div>
    );
  }
  if (!list) {
    return (
      <div className={styles.panel}>
        <p className={styles.meta} role="status">
          {t('loading')}
        </p>
      </div>
    );
  }

  const backButton = (
    <Button variant="ghost" onClick={() => show({ kind: 'list' })}>
      <ArrowLeft size={20} strokeWidth={1.75} aria-hidden="true" />
      {t('back')}
    </Button>
  );

  if (view.kind === 'create') {
    return (
      <div className={styles.panel}>
        <SubmissionForm
          mode="draft"
          heading={t('form.createTitle')}
          initial={{ title: null, filePaths: [], message: null, dueAt: null, reviewerIds: [] }}
          paths={paths}
          candidates={list.candidates}
          submitLabel={t('form.save')}
          onSubmit={create}
          onCancel={() => setView({ kind: 'list' })}
        />
      </div>
    );
  }

  if (view.kind !== 'list' && detail?.id === view.id) {
    if (view.kind === 'edit' || view.kind === 'send') {
      const sending = view.kind === 'send';
      const resend = detail.status === 'FEEDBACK_SENT';
      return (
        <div className={styles.panel}>
          <SubmissionForm
            mode={sending ? 'send' : 'draft'}
            heading={sending ? (resend ? t('resendTitle') : t('sendTitle')) : t('form.editTitle')}
            help={sending ? t('sendHelp') : undefined}
            initial={{
              title: detail.title,
              filePaths: detail.filePaths,
              message: resend ? null : detail.message,
              dueAt: detail.dueAt,
              reviewerIds: detail.reviewers.map((item) => item.id),
            }}
            paths={paths}
            candidates={list.candidates}
            submitLabel={sending ? t('send') : t('form.save')}
            onSubmit={(values) => (sending ? send(detail.id, values) : save(detail.id, values))}
            onCancel={() => setView({ kind: 'detail', id: detail.id })}
          />
        </div>
      );
    }

    const lastAttempt = detail.versions[0];
    const failed = lastAttempt?.state === 'FAILED' ? lastAttempt : null;
    const validated = [...detail.events]
      .reverse()
      .find((event) => event.action === 'SUBMISSION_VALIDATED');
    return (
      <div className={styles.panel}>
        {backButton}
        <h3 className={styles.heading}>{titleOf(detail)}</h3>
        <div className={styles.row}>
          <SubmissionStatusBadge status={detail.status} label={statusLabel(detail.status)} />
          {detail.lastNumber && (
            <span className={styles.meta}>{t('version', { number: detail.lastNumber })}</span>
          )}
        </div>
        <p className={styles.meta}>
          {detail.dueAt ? t('due', { date: when(detail.dueAt) }) : t('noDue')}
          {' · '}
          {detail.reviewers.map((item) => item.name).join(', ')}
        </p>
        {detail.sending && (
          <Alert tone="info">
            <p>
              <strong>{t('sending')}</strong> {t('sendingHelp')}
            </p>
          </Alert>
        )}
        {failed && !detail.sending && (
          <Alert tone="error">
            <p>
              {t('sendFailed')}{' '}
              {failed.compilation &&
                failed.compilation.errorCount > 0 &&
                t('sendFailedErrors', { count: failed.compilation.errorCount })}{' '}
              {failed.compilation?.log && (
                <a
                  href={`/${API_PREFIX}/projects/${projectId}/compilations/${failed.compilation.id}/log`}
                >
                  {t('showLog')}
                </a>
              )}
            </p>
          </Alert>
        )}
        {(detail.status === 'SUBMITTED' ||
          detail.status === 'IN_REVIEW' ||
          detail.status === 'REVISED') &&
          !detail.sending && <Alert tone="info">{t('waitingNotice')}</Alert>}
        {detail.status === 'FEEDBACK_SENT' && !detail.sending && (
          <Alert tone="warning">{t('feedbackNotice')}</Alert>
        )}
        {detail.status === 'VALIDATED' && detail.validatedAt && (
          <Alert tone="success">
            {t('validatedNotice', {
              number: detail.validatedNumber ?? 0,
              date: when(detail.validatedAt),
              name: detail.validatedBy?.name ?? '',
            })}
          </Alert>
        )}
        {validated && validated.restored.length > 0 && validated.beforeVersionLabel && (
          <Alert tone="info">{t('restoredNotice', { label: validated.beforeVersionLabel })}</Alert>
        )}
        {detail.unlockedAt && (
          <Alert tone="info">
            {t('unlockedNotice', {
              date: when(detail.unlockedAt),
              name: detail.unlockedBy?.name ?? '',
            })}
          </Alert>
        )}
        <div className={styles.actions}>
          {detail.can.send && (
            <Button onClick={() => setView({ kind: 'send', id: detail.id })}>
              {detail.status === 'FEEDBACK_SENT' ? t('resend') : t('send')}
            </Button>
          )}
          {detail.can.edit && (
            <Button variant="secondary" onClick={() => setView({ kind: 'edit', id: detail.id })}>
              {t('edit')}
            </Button>
          )}
          {detail.can.delete && (
            <Button variant="ghost" onClick={() => setDeleting(true)}>
              {t('delete')}
            </Button>
          )}
        </div>
        {detail.versions.some((version) => version.state === 'READY') && (
          <>
            <h4 className={styles.subheading}>{t('versions')}</h4>
            <ul className={styles.list}>
              {detail.versions
                .filter((version) => version.state === 'READY')
                .map((version) => (
                  <li key={version.id} className={styles.item}>
                    <span className={styles.itemTitle}>
                      {t('versionLong', { number: version.number ?? 0 })}
                    </span>
                    <span className={styles.meta}>
                      {t('versionSent', {
                        date: when(version.readyAt ?? version.createdAt),
                        name: version.sentBy.name,
                      })}
                    </span>
                  </li>
                ))}
            </ul>
          </>
        )}
        <ButtonLink href={reviewHref(detail.id)} variant="secondary">
          {t('open')}
        </ButtonLink>
        <ConfirmDialog
          open={deleting}
          title={t('deleteTitle')}
          text={t('deleteText', { title: titleOf(detail) })}
          confirmLabel={t('delete')}
          onConfirm={remove}
          onClose={() => setDeleting(false)}
        />
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      {list.canCreate && (
        <Button onClick={() => setView({ kind: 'create' })}>
          <Plus size={20} strokeWidth={1.75} aria-hidden="true" />
          {t('new')}
        </Button>
      )}
      {error && <Alert tone="error">{errorMessage(error)}</Alert>}
      {list.submissions.length === 0 ? (
        <EmptyState
          icon={FileCheck}
          title={t('emptyTitle')}
          text={list.canCreate ? t('emptyText') : t('emptyReader')}
        />
      ) : (
        <ul className={styles.list}>
          {list.submissions.map((item) => (
            <li key={item.id} className={styles.item}>
              <button
                type="button"
                className={styles.itemButton}
                onClick={() => setView({ kind: 'detail', id: item.id })}
              >
                <span className={styles.itemTitle}>{titleOf(item)}</span>
                <span className={styles.row}>
                  <SubmissionStatusBadge status={item.status} label={statusLabel(item.status)} />
                  {item.lastNumber && (
                    <span className={styles.meta}>{t('version', { number: item.lastNumber })}</span>
                  )}
                </span>
                <span className={styles.meta}>
                  {item.dueAt ? t('due', { date: when(item.dueAt) }) : t('noDue')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
