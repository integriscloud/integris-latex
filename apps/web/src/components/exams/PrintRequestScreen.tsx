'use client';

import type { PrintLink, PrintRequestPage } from '@integris/shared';
import { Alert, Button, EmptyState, Panel, TextField } from '@integris/ui';
import { Download, Eye, Lock } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { apiPost, apiRead, type ClientError } from '../../lib/api-client';
import { PdfViewer } from '../editor/PdfViewer';
import styles from './exams.module.css';
import { PrintBadge, PrintDetails, PrintJournal, useExamErrorMessage } from './print-shared';

/**
 * "Ouvrir et imprimer" (mockup secretariat-02, rebuilt): the subject is opened only from its
 * availability date, as a preview watermarked by the server with the reader's name; the clean
 * file comes from a one-time link valid 10 minutes; then the printed count and the handover.
 * The teacher and co-editors see the same preview after the date; the owner and admins of the
 * organization see the request and its journal only.
 */
export function PrintRequestScreen({ initial }: { initial: PrintRequestPage }) {
  const t = useTranslations('Secretariat.request');
  const te = useTranslations('Editor');
  const format = useFormatter();
  const errorMessage = useExamErrorMessage();
  const [page, setPage] = useState(initial);
  const [preview, setPreview] = useState<PrintLink | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const request = page.request;
  const [count, setCount] = useState(String(request.copies + request.reserveCopies));
  const [to, setTo] = useState('');
  const [tried, setTried] = useState(false);

  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  const reload = async () => {
    const result = await apiRead<PrintRequestPage>(`print-requests/${request.id}`);
    if (result.ok) setPage(result.data);
  };

  const call = async <T,>(key: string, path: string, body: object = {}) => {
    setBusy(key);
    setError(null);
    const result = await apiPost<T>(path, body);
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return null;
    }
    return result.data;
  };

  const open = async () => {
    const link = await call<PrintLink>('open', `print-requests/${request.id}/preview`);
    if (link) setPreview(link);
    await reload();
  };

  const download = async () => {
    const link = await call<PrintLink>('print', `print-requests/${request.id}/print-link`);
    if (!link) return;
    setDownloaded(true);
    // The browser saves the file (attachment); the link works once, for 10 minutes.
    window.location.assign(link.url);
    window.setTimeout(() => void reload(), 2000);
  };

  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    const value = Number(count);
    if (!Number.isInteger(value) || value < 1) {
      setTried(true);
      return;
    }
    const result = await call<PrintRequestPage>('printed', `print-requests/${request.id}/printed`, {
      count: value,
    });
    if (result) setPage(result);
  };

  const handOver = async (event: FormEvent) => {
    event.preventDefault();
    if (!to.trim()) {
      setTried(true);
      return;
    }
    const result = await call<PrintRequestPage>(
      'handover',
      `print-requests/${request.id}/handed-over`,
      { to: to.trim() },
    );
    if (result) setPage(result);
  };

  const secretary = request.can.print || request.can.confirmPrinted || request.can.handOver;
  const opened = request.openedAt !== null;
  const printed = request.printedAt !== null;
  const handed = request.handedOverAt !== null;
  const steps =
    request.status !== 'CANCELED' &&
    (secretary || ['OPENED', 'PRINTED', 'HANDED_OVER'].includes(request.status));

  return (
    <div className={styles.stack}>
      <div className={styles.badges}>
        <PrintBadge status={request.status} />
        <p className={styles.muted}>
          {t('requestedBy', {
            name: request.teacherName,
            count: request.copies + request.reserveCopies,
          })}
        </p>
      </div>
      {error && (
        <Alert tone="error">
          <p>{errorMessage(error)}</p>
        </Alert>
      )}
      <div className={styles.grid}>
        <div className={styles.viewer}>
          {preview ? (
            <PdfViewer
              documentKey={preview.url}
              url={preview.url}
              highlight={null}
              labels={{
                toolbar: te('pdfViewer.toolbar'),
                previous: te('pdfViewer.previous'),
                next: te('pdfViewer.next'),
                page: (pageNumber, pages) => te('pdfViewer.page', { page: pageNumber, pages }),
                pageLabel: (pageNumber) => te('pdfViewer.pageLabel', { page: pageNumber }),
                zoomIn: te('pdfViewer.zoomIn'),
                zoomOut: te('pdfViewer.zoomOut'),
                fit: te('pdfViewer.fit'),
                download: te('pdfViewer.download'),
                loading: te('pdfViewer.loading'),
                failed: te('pdfViewer.failed'),
                retry: te('retry'),
              }}
            />
          ) : request.locked ? (
            <EmptyState
              icon={Lock}
              title={t('locked', { date: when(request.availableFrom) })}
              text={t('lockedHelp')}
            />
          ) : request.can.preview ? (
            <EmptyState
              icon={Eye}
              title={t('openTitle')}
              text={secretary ? t('openHelp') : t('openHelpAuthor')}
              action={
                <Button busy={busy === 'open'} onClick={() => void open()}>
                  {t('open')}
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Lock}
              title={request.status === 'CANCELED' ? t('canceled') : t('noPreview')}
              text={request.status === 'CANCELED' ? undefined : t('noPreviewHelp')}
            />
          )}
        </div>

        <div className={styles.stack}>
          <Panel title={t('details')}>
            <PrintDetails request={request} />
          </Panel>

          {steps && (
            <Panel title={t('steps')}>
              <ol className={styles.steps}>
                <li className={`${styles.step} ${opened ? styles.stepDone : ''}`}>
                  <p className={styles.name}>{t('stepOpen')}</p>
                  <p className={styles.muted}>
                    {opened ? t('openedAt', { date: when(request.openedAt!) }) : t('notOpened')}
                  </p>
                </li>
                <li className={`${styles.step} ${printed ? styles.stepDone : ''}`}>
                  <p className={styles.name}>{t('stepPrint')}</p>
                  <p className={styles.muted}>{t('printHelp')}</p>
                  {request.can.print && (
                    <div className={styles.actions}>
                      <Button
                        variant={printed ? 'secondary' : 'primary'}
                        busy={busy === 'print'}
                        onClick={() => void download()}
                      >
                        <Download size={20} strokeWidth={1.75} aria-hidden="true" />
                        {t('download')}
                      </Button>
                    </div>
                  )}
                  {downloaded && <p className={styles.muted}>{t('downloadStarted')}</p>}
                </li>
                <li className={`${styles.step} ${printed ? styles.stepDone : ''}`}>
                  <p className={styles.name}>{t('stepConfirm')}</p>
                  {printed ? (
                    <p className={styles.muted}>
                      {t('printedAt', {
                        count: request.printedCount ?? 0,
                        date: when(request.printedAt!),
                      })}
                    </p>
                  ) : request.can.confirmPrinted ? (
                    <form className={styles.inline} onSubmit={confirm}>
                      <TextField
                        label={t('printedCount')}
                        inputMode="numeric"
                        value={count}
                        error={tried ? t('countInvalid') : undefined}
                        onChange={(event) => setCount(event.target.value)}
                      />
                      <Button type="submit" busy={busy === 'printed'}>
                        {t('confirm')}
                      </Button>
                    </form>
                  ) : (
                    <p className={styles.muted}>{t('waiting')}</p>
                  )}
                </li>
                <li className={`${styles.step} ${handed ? styles.stepDone : ''}`}>
                  <p className={styles.name}>{t('stepHandOver')}</p>
                  {handed ? (
                    <p className={styles.muted}>
                      {t('handedOverAt', {
                        to: request.handedOverTo ?? '',
                        date: when(request.handedOverAt!),
                      })}
                    </p>
                  ) : request.can.handOver ? (
                    <form className={styles.inline} onSubmit={handOver}>
                      <TextField
                        label={t('handedOverTo')}
                        help={t('handedOverToHelp')}
                        value={to}
                        maxLength={120}
                        error={tried && !to.trim() ? t('toRequired') : undefined}
                        onChange={(event) => setTo(event.target.value)}
                      />
                      <Button type="submit" busy={busy === 'handover'}>
                        {t('handOver')}
                      </Button>
                    </form>
                  ) : (
                    <p className={styles.muted}>{t('waiting')}</p>
                  )}
                </li>
              </ol>
            </Panel>
          )}

          <Panel title={t('journal')}>
            <PrintJournal events={page.events} />
          </Panel>
        </div>
      </div>
    </div>
  );
}
