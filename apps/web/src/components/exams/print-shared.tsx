'use client';

import {
  EXAM_ERROR_CODES,
  type ExamErrorCode,
  type PrintEventView,
  type PrintRequestView,
} from '@integris/shared';
import { EmptyState, PrintStatusBadge } from '@integris/ui';
import { ScrollText } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useCallback } from 'react';
import type { ClientError } from '../../lib/api-client';
import { useOrgErrorMessage } from '../organization/use-org-error';
import styles from './exams.module.css';

const isExamError = (code: string): code is ExamErrorCode =>
  (EXAM_ERROR_CODES as readonly string[]).includes(code);

/** Translated message of an error of the exam papers and secretariat endpoints. */
export function useExamErrorMessage() {
  const t = useTranslations('ExamErrors');
  const format = useFormatter();
  const fallback = useOrgErrorMessage();
  return useCallback(
    (error: ClientError) => {
      if (error.code === 'print_locked' && error.retryAfter !== undefined) {
        const at = new Date(Date.now() + error.retryAfter * 1000);
        return t('print_locked_until', {
          date: format.dateTime(at, { dateStyle: 'medium', timeStyle: 'short' }),
        });
      }
      return isExamError(error.code) ? t(error.code) : fallback(error);
    },
    [t, format, fallback],
  );
}

export function PrintBadge({ status }: { status: PrintRequestView['status'] }) {
  const t = useTranslations('Print.status');
  return <PrintStatusBadge status={status} label={t(status)} />;
}

/** "Recto-verso, agrafé": the format of the copies. */
export function useFormatLabel() {
  const t = useTranslations('Print');
  return useCallback(
    (request: Pick<PrintRequestView, 'duplex' | 'stapled'>) =>
      [t(`duplex.${request.duplex}`), request.stapled ? t('stapled') : null]
        .filter(Boolean)
        .join(', '),
    [t],
  );
}

/** What a print request asks for: class, copies, format, dates, pages, teacher. */
export function PrintDetails({
  request,
  teacher = true,
}: {
  request: PrintRequestView;
  teacher?: boolean;
}) {
  const t = useTranslations('Print');
  const format = useFormatter();
  const formatLabel = useFormatLabel();
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <dl className={styles.details}>
      {teacher && (
        <>
          <dt>{t('fields.teacher')}</dt>
          <dd>{request.teacherName}</dd>
        </>
      )}
      <dt>{t('fields.group')}</dt>
      <dd>{request.groupName}</dd>
      <dt>{t('fields.copies')}</dt>
      <dd>
        {t('copiesValue', {
          copies: request.copies,
          reserve: request.reserveCopies,
          total: request.copies + request.reserveCopies,
        })}
      </dd>
      <dt>{t('fields.format')}</dt>
      <dd>
        {formatLabel(request)} · {t('pages', { count: request.pages })}
      </dd>
      <dt>{t('fields.availableFrom')}</dt>
      <dd>{when(request.availableFrom)}</dd>
      <dt>{t('fields.examAt')}</dt>
      <dd>{when(request.examAt)}</dd>
      {request.printedCount !== null && (
        <>
          <dt>{t('fields.printed')}</dt>
          <dd>{t('printedValue', { count: request.printedCount })}</dd>
        </>
      )}
      {request.handedOverTo && (
        <>
          <dt>{t('fields.handedOverTo')}</dt>
          <dd>{request.handedOverTo}</dd>
        </>
      )}
    </dl>
  );
}

/** One line of the access journal: what, who, when, from which address. */
function eventText(
  event: PrintEventView,
  t: ReturnType<typeof useTranslations<'Print'>>,
  fields: (names: string[]) => string,
): string {
  const who = event.mine ? t('journal.you') : (event.actorName ?? t('journal.someone'));
  switch (event.type) {
    case 'REQUESTED':
      return t('journal.REQUESTED', { who });
    case 'UPDATED':
      return t('journal.UPDATED', { who, fields: fields(event.details.changes) });
    case 'CANCELED':
      return event.details.replaced
        ? t('journal.REPLACED', { who })
        : t('journal.CANCELED', { who });
    case 'OPENED':
      return event.details.byAuthor
        ? t('journal.PREVIEWED', { who })
        : t('journal.OPENED', { who });
    case 'DOWNLOADED':
      return t('journal.DOWNLOADED', { who });
    case 'PRINT_CONFIRMED':
      return t('journal.PRINT_CONFIRMED', { who, count: event.details.count ?? 0 });
    case 'HANDED_OVER':
      return t('journal.HANDED_OVER', { who, to: event.details.to ?? '' });
    case 'COEDITOR_ADDED':
      return t('journal.COEDITOR_ADDED', { who, name: event.details.userName ?? '' });
    case 'COEDITOR_REMOVED':
      return t('journal.COEDITOR_REMOVED', { who, name: event.details.userName ?? '' });
  }
}

/** Append-only access journal: each send, change, opening, download, print and handover. */
export function PrintJournal({
  events,
  showRequest = false,
}: {
  events: PrintEventView[];
  /** Name the request (and exam paper) of each line: journals of several requests. */
  showRequest?: boolean;
}) {
  const t = useTranslations('Print');
  const format = useFormatter();
  const fields = (names: string[]) =>
    names.map((name) => t(`changes.${name as 'title'}`)).join(', ');
  if (!events.length) {
    return <EmptyState icon={ScrollText} title={t('journal.empty')} />;
  }
  return (
    <ol className={styles.journal} aria-label={t('journal.label')}>
      {events.map((event) => (
        <li key={event.id} className={styles.event}>
          <p className={styles.eventWhat}>
            {eventText(event, t, fields)}
            {showRequest && (event.requestTitle || event.projectName) && (
              <>
                {' · '}
                <span className={styles.muted}>{event.requestTitle ?? event.projectName}</span>
              </>
            )}
          </p>
          <p className={styles.eventMeta}>
            {format.dateTime(new Date(event.createdAt), { dateStyle: 'short', timeStyle: 'short' })}
            {event.ip && ` · ${t('journal.ip', { ip: event.ip })}`}
          </p>
        </li>
      ))}
    </ol>
  );
}
