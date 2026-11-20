'use client';

import type { RestoreResult, VersionDetail, VersionList, VersionSummary } from '@integris/shared';
import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  Dialog,
  EmptyState,
  type TimelineItem,
  VersionTimeline,
} from '@integris/ui';
import { ArrowLeft, CircleCheck, History, RefreshCw } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { getPathname } from '../../i18n/navigation';
import { apiPost, apiRead, type ClientError } from '../../lib/api-client';
import { ConfirmDialog, TextDialog } from '../app/dialogs';
import { useApiErrorMessage } from '../app/use-api-error';
import styles from './editor.module.css';

export interface HistoryPanelProps {
  projectId: string;
  /** Writes the open files to storage first (named version, restoration). */
  flush: () => Promise<boolean>;
  /** The project files changed (restoration). */
  onRestored: () => void;
  /** Version shown at once (a link from elsewhere in the editor). */
  initialSelected?: string | null;
}

type Confirm = { path: string | null } | null;

/**
 * Version history of the project (docs/spec.md, "Historique"): automatic versions, named
 * versions, comparison of a version with the project, preview of its text files, restoration of
 * the whole project or of one file. Every role reads; owners and editors name and restore.
 */
export function HistoryPanel({
  projectId,
  flush,
  onRestored,
  initialSelected = null,
}: HistoryPanelProps) {
  const t = useTranslations('History');
  const locale = useLocale();
  const format = useFormatter();
  const errorMessage = useApiErrorMessage(locale);
  const [list, setList] = useState<VersionList | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<string | null>(initialSelected);
  const [detail, setDetail] = useState<VersionDetail | null>(null);
  const [preview, setPreview] = useState<{ path: string; text: string } | null>(null);
  const [naming, setNaming] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [report, setReport] = useState<RestoreResult | null>(null);

  const when = useCallback(
    (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' }),
    [format],
  );

  useEffect(() => {
    let cancelled = false;
    void apiRead<VersionList>(`projects/${projectId}/versions`).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setList(result.data);
        setError(null);
      } else {
        setError(result.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, attempt]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    // Compared with the project as stored: the last changes are written first.
    void flush()
      .then(() => apiRead<VersionDetail>(`projects/${projectId}/versions/${selected}`))
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setDetail(result.data);
        else {
          setError(result.error);
          setSelected(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, selected, attempt, flush]);

  const refresh = () => setAttempt((value) => value + 1);

  const title = (version: VersionSummary) => {
    if (version.restoreOf) {
      const date = version.restoreOf.createdAt ? when(version.restoreOf.createdAt) : '';
      return version.restoreOf.path
        ? t('beforeRestoreFile', { path: version.restoreOf.path, date })
        : t('beforeRestore', { date });
    }
    if (version.kind === 'NAMED') return version.label ?? t('named');
    if (version.kind === 'SUBMISSION') return t('submission');
    return t('auto');
  };

  const meta = (version: VersionSummary) =>
    [
      version.kind === 'NAMED' ? t('named') : null,
      when(version.createdAt),
      version.authorName,
      t('fileCount', { count: version.fileCount }),
    ]
      .filter(Boolean)
      .join(' · ');

  const name = async (label: string) => {
    if (!(await flush())) return t('flushFailed');
    const result = await apiPost<VersionSummary>(`projects/${projectId}/versions`, { label });
    if (!result.ok) return errorMessage(result.error);
    refresh();
    return null;
  };

  const restore = async () => {
    if (!selected || !confirm) return null;
    // The changes not yet in storage are part of the state saved before the restoration.
    if (!(await flush())) return t('flushFailed');
    const result = await apiPost<RestoreResult>(
      `projects/${projectId}/versions/${selected}/restore`,
      confirm.path ? { path: confirm.path } : {},
    );
    if (!result.ok) return errorMessage(result.error);
    setReport(result.data);
    setPreview(null);
    setSelected(null);
    setDetail(null);
    refresh();
    onRestored();
    return null;
  };

  const openPreview = async (path: string) => {
    const result = await apiRead<string>(
      `projects/${projectId}/versions/${selected}/file?path=${encodeURIComponent(path)}`,
      'text',
    );
    if (result.ok) setPreview({ path, text: result.data });
    else setError(result.error);
  };

  const canRestore = list?.canRestore ?? false;
  const version = detail && detail.version.id === selected ? detail : null;
  const pricing = `${getPathname({ href: '/', locale })}#pricing`;

  if (selected) {
    return (
      <div className={styles.history}>
        <Button
          variant="secondary"
          onClick={() => {
            setSelected(null);
            setDetail(null);
          }}
        >
          <ArrowLeft size={20} strokeWidth={1.75} aria-hidden="true" />
          {t('back')}
        </Button>
        {!version ? (
          <p className={styles.loading} role="status">
            {t('loading')}
          </p>
        ) : (
          <>
            <div>
              <h3 className={styles.historyTitle}>{title(version.version)}</h3>
              <p className={styles.menuHelp}>{meta(version.version)}</p>
            </div>
            {canRestore && (
              <Button onClick={() => setConfirm({ path: null })}>{t('restoreAll')}</Button>
            )}
            <h4 className={styles.historyHeading}>{t('filesHeading')}</h4>
            <ul className={styles.versionFiles}>
              {version.files.map((file) => (
                <li key={file.path}>
                  {file.kind === 'TEXT' ? (
                    <button
                      type="button"
                      className={styles.versionFile}
                      onClick={() => void openPreview(file.path)}
                    >
                      {file.path}
                    </button>
                  ) : (
                    <span className={styles.versionFile}>{file.path}</span>
                  )}
                  <Badge tone={file.change === 'same' ? 'neutral' : 'warning'}>
                    {t(`change.${file.change}`)}
                  </Badge>
                </li>
              ))}
            </ul>
            {version.added.length > 0 && (
              <>
                <h4 className={styles.historyHeading}>{t('addedHeading')}</h4>
                <ul className={styles.versionFiles}>
                  {version.added.map((path) => (
                    <li key={path}>
                      <span className={styles.versionFile}>{path}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {!canRestore && <p className={styles.menuHelp}>{t('readOnlyHint')}</p>}
          </>
        )}
        <Dialog
          open={preview !== null}
          title={preview ? t('previewTitle', { path: preview.path }) : ''}
          closeLabel={t('close')}
          onClose={() => setPreview(null)}
          actions={
            <>
              <Button variant="secondary" onClick={() => setPreview(null)}>
                {t('close')}
              </Button>
              {canRestore && preview && (
                <Button onClick={() => setConfirm({ path: preview.path })}>
                  {t('restoreFile')}
                </Button>
              )}
            </>
          }
        >
          <pre className={styles.previewText}>{preview?.text}</pre>
        </Dialog>
        <ConfirmDialog
          open={confirm !== null}
          title={
            confirm?.path ? t('confirmFileTitle', { path: confirm.path }) : t('confirmAllTitle')
          }
          text={
            confirm?.path
              ? t('confirmFileText', {
                  path: confirm.path,
                  date: version ? when(version.version.createdAt) : '',
                })
              : t('confirmAllText', { date: version ? when(version.version.createdAt) : '' })
          }
          confirmLabel={t('confirm')}
          onConfirm={restore}
          onClose={() => setConfirm(null)}
        />
      </div>
    );
  }

  const items: TimelineItem[] = list
    ? [
        { id: 'current', title: t('current'), meta: t('currentMeta'), tone: 'current' },
        ...list.versions.map((item): TimelineItem => ({
          id: item.id,
          title: title(item),
          meta: meta(item),
          tone: item.kind === 'NAMED' ? 'named' : 'auto',
        })),
      ]
    : [];

  return (
    <div className={styles.history}>
      <div className={styles.historyActions}>
        {canRestore && (
          <Button variant="secondary" onClick={() => setNaming(true)}>
            {t('nameAction')}
          </Button>
        )}
        <Button variant="secondary" onClick={refresh} aria-label={t('refresh')}>
          <RefreshCw size={20} strokeWidth={1.75} aria-hidden="true" />
        </Button>
      </div>
      {report && (
        <Alert tone="success">
          <p>
            <CircleCheck size={16} strokeWidth={1.75} aria-hidden="true" />{' '}
            {t('restored', { restored: report.restored, removed: report.removed })}
            {report.kept.length > 0 && <> {t('kept', { paths: report.kept.join(', ') })}</>}
          </p>
        </Alert>
      )}
      {error && (
        <Alert tone="error">
          {errorMessage(error)}{' '}
          <Button variant="secondary" onClick={refresh}>
            {t('retry')}
          </Button>
        </Alert>
      )}
      {!list && !error && (
        <p className={styles.loading} role="status">
          {t('loading')}
        </p>
      )}
      {list && (
        <>
          <p className={styles.menuHelp}>
            {list.historyDays === null
              ? t('limitNone')
              : t('limitDays', { days: list.historyDays })}
          </p>
          {list.hiddenCount > 0 && (
            <Alert tone="info">
              <p>
                {t('hidden', { count: list.hiddenCount })}{' '}
                <ButtonLink href={pricing} variant="accent">
                  {t('upgrade')}
                </ButtonLink>
              </p>
            </Alert>
          )}
          {list.versions.length === 0 ? (
            <EmptyState icon={History} title={t('emptyTitle')} text={t('emptyText')} />
          ) : (
            <VersionTimeline
              items={items}
              label={t('title')}
              onSelect={(id) => {
                setReport(null);
                setSelected(id);
              }}
            />
          )}
        </>
      )}
      <TextDialog
        open={naming}
        title={t('nameTitle')}
        label={t('nameLabel')}
        help={t('nameHelp')}
        initial=""
        submitLabel={t('nameSubmit')}
        onSubmit={name}
        onClose={() => setNaming(false)}
      />
    </div>
  );
}
