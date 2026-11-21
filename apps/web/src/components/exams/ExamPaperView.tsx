'use client';

import {
  EXAM_PART_FILES,
  EXAM_PARTS,
  type ExamPaperDetail,
  type PrintEventView,
  type PrintRequestView,
} from '@integris/shared';
import { Alert, Button, ButtonLink, Dialog, EmptyState, Panel, SelectField } from '@integris/ui';
import { FilePen, Printer, Send } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { getPathname } from '../../i18n/navigation';
import { apiRead, apiRequest, type ClientError } from '../../lib/api-client';
import styles from './exams.module.css';
import { type PrintFormValue, PrintRequestForm } from './PrintRequestForm';
import { PrintBadge, PrintDetails, PrintJournal, useExamErrorMessage } from './print-shared';

type Editing = { mode: 'send' } | { mode: 'modify' | 'replace'; request: PrintRequestView };

/**
 * One exam paper (mockup professeur-03 "rédiger un devoir", rebuilt plain): its three parts,
 * "Envoyer au secrétariat", the requests with their status and actions (change or cancel before
 * opening, cancel and send again after), the co-editors and the journal. `compact` is the side
 * panel of the editor.
 */
export function ExamPaperView({
  initial,
  fileIds,
  compact = false,
}: {
  initial: ExamPaperDetail;
  /** Ids of the subject, answer key and marking scheme files, to open them in the editor. */
  fileIds?: Partial<Record<string, string>>;
  compact?: boolean;
}) {
  const t = useTranslations('Exams');
  const tApp = useTranslations('App');
  const locale = useLocale();
  const errorMessage = useExamErrorMessage();
  const [detail, setDetail] = useState(initial);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const [formError, setFormError] = useState<ClientError | null>(null);
  const [canceling, setCanceling] = useState<PrintRequestView | null>(null);
  const [coeditor, setCoeditor] = useState('');
  const [events, setEvents] = useState<PrintEventView[] | null>(null);

  const reload = async () => {
    const result = await apiRead<ExamPaperDetail>(`exam-papers/${detail.id}`);
    if (result.ok) setDetail(result.data);
  };

  const sending = detail.send?.status === 'COMPILING';
  // While the subject compiles, the page follows the send until the request exists.
  useEffect(() => {
    if (!sending) return;
    const timer = setInterval(() => {
      void apiRead<ExamPaperDetail>(`exam-papers/${initial.id}`).then((result) => {
        if (result.ok) setDetail(result.data);
      });
    }, 2500);
    return () => clearInterval(timer);
  }, [sending, initial.id]);

  const journalKey = `${detail.requests.map((request) => request.status).join()}:${detail.coeditors.length}`;
  useEffect(() => {
    if (compact) return;
    void apiRead<{ events: PrintEventView[] }>(`exam-papers/${initial.id}/journal`).then(
      (result) => {
        if (result.ok) setEvents(result.data.events);
      },
    );
  }, [compact, initial.id, journalKey]);

  const editorHref = (part: (typeof EXAM_PARTS)[number]) => {
    const id = fileIds?.[EXAM_PART_FILES[part]];
    return `${getPathname({ href: `/app/projects/${detail.id}/edit`, locale })}${id ? `?file=${encodeURIComponent(id)}` : ''}`;
  };
  const requestHref = (id: string) => getPathname({ href: `/app/print/${id}`, locale });

  const submit = async (value: PrintFormValue) => {
    if (!editing) return;
    setBusy('form');
    setFormError(null);
    const result =
      editing.mode === 'modify'
        ? await apiRequest<ExamPaperDetail>('PATCH', `print-requests/${editing.request.id}`, value)
        : await apiRequest<ExamPaperDetail>('POST', `exam-papers/${detail.id}/send`, {
            ...value,
            ...(editing.mode === 'replace' ? { replacesId: editing.request.id } : {}),
          });
    setBusy(null);
    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    setDetail(result.data);
    setEditing(null);
  };

  const cancel = async () => {
    if (!canceling) return;
    setBusy('cancel');
    setError(null);
    const result = await apiRequest('POST', `print-requests/${canceling.id}/cancel`);
    setBusy(null);
    setCanceling(null);
    if (!result.ok) setError(result.error);
    await reload();
  };

  const changeCoeditor = async (userId: string, add: boolean) => {
    setBusy(`coeditor-${userId}`);
    setError(null);
    const result = add
      ? await apiRequest<ExamPaperDetail>('POST', `exam-papers/${detail.id}/coeditors`, { userId })
      : await apiRequest<ExamPaperDetail>(
          'DELETE',
          `exam-papers/${detail.id}/coeditors/${encodeURIComponent(userId)}`,
        );
    setBusy(null);
    if (!result.ok) setError(result.error);
    else {
      setDetail(result.data);
      setCoeditor('');
    }
  };

  const running = detail.requests.filter((request) => request.status !== 'CANCELED');
  const canceled = detail.requests.filter((request) => request.status === 'CANCELED');
  const shownRequests = compact ? running.slice(0, 1) : [...running, ...canceled];

  const sendState = detail.send && detail.send.status !== 'DONE' && (
    <Alert tone={detail.send.status === 'FAILED' ? 'error' : 'info'}>
      {detail.send.status === 'COMPILING' ? (
        <p>{t('send.compiling')}</p>
      ) : (
        <>
          <p>
            {detail.send.reason
              ? errorMessage({ code: detail.send.reason as ClientError['code'] })
              : t('send.failed')}
          </p>
          {detail.send.issues.length > 0 && (
            <ul>
              {detail.send.issues.map((issue, index) => (
                <li key={index}>
                  {issue.file && issue.line
                    ? t('send.issueAt', { file: issue.file, line: issue.line, text: issue.raw })
                    : issue.raw}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Alert>
  );

  const requestCard = (request: PrintRequestView) => (
    <li key={request.id} className={styles.card}>
      <div className={styles.who}>
        <div className={styles.badges}>
          <p className={styles.name}>{request.title}</p>
          <PrintBadge status={request.status} />
        </div>
        <PrintDetails request={request} teacher={false} />
      </div>
      <div className={styles.actions}>
        {request.can.preview && (
          <ButtonLink variant="secondary" href={requestHref(request.id)}>
            {t('requests.preview')}
          </ButtonLink>
        )}
        {!request.can.preview && request.status !== 'CANCELED' && !compact && (
          <ButtonLink variant="ghost" href={requestHref(request.id)}>
            {t('requests.follow')}
          </ButtonLink>
        )}
        {request.can.modify && (
          <Button
            variant="secondary"
            onClick={() => {
              setFormError(null);
              setEditing({ mode: 'modify', request });
            }}
          >
            {t('requests.modify')}
          </Button>
        )}
        {request.can.replace && (
          <Button
            variant="secondary"
            disabled={sending}
            onClick={() => {
              setFormError(null);
              setEditing({ mode: 'replace', request });
            }}
          >
            {t('requests.replace')}
          </Button>
        )}
        {request.can.cancel && (
          <Button variant="ghost" onClick={() => setCanceling(request)}>
            {t('requests.cancel')}
          </Button>
        )}
      </div>
    </li>
  );

  return (
    <div className={styles.stack}>
      {!compact && (
        <div className={styles.parts}>
          {EXAM_PARTS.map((part) => (
            <ButtonLink key={part} variant="secondary" href={editorHref(part)}>
              <FilePen size={20} strokeWidth={1.75} aria-hidden="true" />
              {t(`parts.${part}`)}
            </ButtonLink>
          ))}
        </div>
      )}
      {!compact && <p className={styles.muted}>{t('partsHelp')}</p>}

      {error && (
        <Alert tone="error">
          <p>{errorMessage(error)}</p>
        </Alert>
      )}

      <Panel title={t('send.title')}>
        <div className={styles.stack}>
          {sendState}
          {editing ? (
            <PrintRequestForm
              key={`${editing.mode}-${'request' in editing ? editing.request.id : ''}`}
              groups={detail.groups}
              defaultTitle={detail.name}
              initial={'request' in editing ? editing.request : undefined}
              submitLabel={editing.mode === 'modify' ? t('send.saveChanges') : t('send.submit')}
              busy={busy === 'form'}
              error={formError}
              onSubmit={(value) => void submit(value)}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <>
              {shownRequests.length ? (
                <ul className={styles.list}>{shownRequests.map(requestCard)}</ul>
              ) : (
                <EmptyState
                  icon={Printer}
                  title={t('requests.empty')}
                  text={t('requests.emptyHelp')}
                />
              )}
              {detail.canSend ? (
                <div className={styles.actions}>
                  <Button
                    disabled={sending}
                    onClick={() => {
                      setFormError(null);
                      setEditing({ mode: 'send' });
                    }}
                  >
                    <Send size={20} strokeWidth={1.75} aria-hidden="true" />
                    {t('send.open')}
                  </Button>
                </div>
              ) : (
                <p className={styles.muted}>{t('send.ownerOnly', { name: detail.ownerName })}</p>
              )}
            </>
          )}
        </div>
      </Panel>

      {!compact && (
        <Panel title={t('coeditors.title')}>
          <div className={styles.stack}>
            <p className={styles.muted}>{t('coeditors.help')}</p>
            {detail.coeditors.length ? (
              <ul className={styles.list}>
                {detail.coeditors.map((person) => (
                  <li key={person.userId} className={styles.card}>
                    <div className={styles.who}>
                      <p className={styles.name}>{person.name}</p>
                      <p className={styles.muted}>{person.organizationName}</p>
                    </div>
                    {detail.canSend && (
                      <Button
                        variant="ghost"
                        busy={busy === `coeditor-${person.userId}`}
                        onClick={() => void changeCoeditor(person.userId, false)}
                      >
                        {t('coeditors.remove')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.muted}>{t('coeditors.none')}</p>
            )}
            {detail.canSend &&
              (detail.candidates.length ? (
                <form
                  className={styles.inline}
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (coeditor) void changeCoeditor(coeditor, true);
                  }}
                >
                  <SelectField
                    label={t('coeditors.choose')}
                    value={coeditor}
                    options={[
                      { value: '', label: t('coeditors.chooseOne') },
                      ...detail.candidates.map((person) => ({
                        value: person.userId,
                        label: `${person.name} · ${person.organizationName}`,
                      })),
                    ]}
                    onChange={(event) => setCoeditor(event.target.value)}
                  />
                  <Button type="submit" variant="secondary" busy={busy === `coeditor-${coeditor}`}>
                    {t('coeditors.add')}
                  </Button>
                </form>
              ) : (
                <p className={styles.muted}>{t('coeditors.noCandidates')}</p>
              ))}
          </div>
        </Panel>
      )}

      {!compact && (
        <Panel title={t('journal')}>
          {events ? (
            <PrintJournal events={events} showRequest />
          ) : (
            <p className={styles.muted}>…</p>
          )}
        </Panel>
      )}

      <Dialog
        open={canceling !== null}
        title={t('cancelDialog.title', { title: canceling?.title ?? '' })}
        closeLabel={tApp('close')}
        onClose={() => setCanceling(null)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setCanceling(null)}>
              {tApp('cancel')}
            </Button>
            <Button variant="primary" busy={busy === 'cancel'} onClick={() => void cancel()}>
              {t('cancelDialog.confirm')}
            </Button>
          </>
        }
      >
        <p>
          {canceling && canceling.status !== 'SCHEDULED' && canceling.status !== 'READY'
            ? t('cancelDialog.afterOpening')
            : t('cancelDialog.text')}
        </p>
      </Dialog>
    </div>
  );
}
