'use client';

import { type ArchiveGrant, movedPath, parentFolder, type ProjectDetail } from '@integris/shared';
import { Alert, Button, Dialog, type FileTreeEntry } from '@integris/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { apiRequest, type ApiResult } from '../../lib/api-client';
import styles from './app.module.css';
import { ConfirmDialog } from './dialogs';
import { useApiErrorMessage } from './use-api-error';

/** A file or a folder of the tree, as moved by drag and drop or "Move to…". */
export interface MovedEntry {
  type: 'file' | 'folder';
  path: string;
  /** Files only. */
  id?: string;
}

export const movedEntry = (entry: FileTreeEntry): MovedEntry =>
  entry.type === 'file'
    ? { type: 'file', path: entry.path, id: entry.file.id }
    : { type: 'folder', path: entry.path };

/** Sends the move of `entry` into `folder` ("" for the root); the answer is the project. */
export function requestMove(
  projectId: string,
  entry: MovedEntry,
  folder: string,
): Promise<ApiResult<ProjectDetail>> {
  const base = `projects/${projectId}`;
  const to = movedPath(entry.path, folder);
  return entry.type === 'file'
    ? apiRequest<ProjectDetail>('PATCH', `${base}/files/${entry.id}`, { path: to })
    : apiRequest<ProjectDetail>('PATCH', `${base}/folders`, { from: entry.path, to });
}

export interface MoveDialogProps {
  /** What is moved; the dialog is open while it is set. */
  entry: MovedEntry | null;
  /** Every folder of the project. */
  folders: readonly string[];
  /** Resolves to an error message, or null on success (the dialog then closes). */
  onMove: (entry: MovedEntry, folder: string) => Promise<string | null>;
  onClose: () => void;
}

/**
 * "Move to…": the destination folder chosen in a list (keyboard and touch screens, where drag
 * and drop is not available). Screen without mockup.
 */
export function MoveDialog({ entry, folders, onMove, onClose }: MoveDialogProps) {
  const t = useTranslations('FileOps');
  const tApp = useTranslations('App');
  const current = entry ? parentFolder(entry.path) : '';
  const [target, setTarget] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Current folder selected and no error each time the dialog opens (adjusted during render).
  const [shown, setShown] = useState(entry);
  if (entry !== shown) {
    setShown(entry);
    if (entry) {
      setTarget(current);
      setError(null);
    }
  }

  // A folder never goes into itself or one of its folders.
  const choices = [
    '',
    ...folders.filter(
      (folder) =>
        entry?.type !== 'folder' || (folder !== entry.path && !folder.startsWith(`${entry.path}/`)),
    ),
  ];

  const submit = async () => {
    if (!entry || target === current) return;
    setBusy(true);
    const message = await onMove(entry, target);
    setBusy(false);
    if (message) setError(message);
    else onClose();
  };

  return (
    <Dialog
      open={entry !== null}
      title={t('moveTitle', { name: entry?.path ?? '' })}
      closeLabel={tApp('close')}
      onClose={onClose}
      onSubmit={submit}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            {tApp('cancel')}
          </Button>
          <Button type="submit" busy={busy} disabled={target === current}>
            {t('move')}
          </Button>
        </>
      }
    >
      {error && <Alert tone="error">{error}</Alert>}
      <fieldset className={styles.folderChoices}>
        <legend className={styles.label}>{t('destination')}</legend>
        {choices.map((folder) => (
          <label key={folder || '/'} className={styles.folderChoice}>
            <input
              type="radio"
              name="move-destination"
              checked={target === folder}
              onChange={() => setTarget(folder)}
            />
            <span className={styles.folderName}>{folder ? `${folder}/` : t('root')}</span>
            {folder === current && <span className={styles.muted}>{t('currentFolder')}</span>}
          </label>
        ))}
      </fieldset>
    </Dialog>
  );
}

/**
 * Download of the whole project (ZIP), for the owner and editors. `beforeStart` writes the text
 * typed in the editor to storage first. A project too large to be imported again gets a warning
 * first; the download is never refused for its size. The browser saves the archive as it comes
 * (a plain navigation to an attachment), never held in the page.
 */
export function useProjectDownload(projectId: string, beforeStart?: () => Promise<unknown>) {
  const t = useTranslations('FileOps');
  const locale = useLocale();
  const message = useApiErrorMessage(locale);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ArchiveGrant | null>(null);

  // An API address answered as an attachment: the page stays, the browser saves the file.
  const follow = (grant: ArchiveGrant) => {
    const path = `/api/projects/${encodeURIComponent(projectId)}/archive?t=${encodeURIComponent(grant.token)}`;
    window.location.assign(new URL(path, window.location.origin).href);
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    await beforeStart?.().catch(() => undefined);
    const result = await apiRequest<ArchiveGrant>('POST', `projects/${projectId}/archive`);
    setBusy(false);
    if (!result.ok) {
      setError(message(result.error));
      return;
    }
    if (result.data.tooLargeForImport) setPending(result.data);
    else follow(result.data);
  };

  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      title={t('downloadTitle')}
      warning={t('downloadTooLarge')}
      text={t('downloadText')}
      confirmLabel={t('downloadAnyway')}
      onConfirm={async () => {
        if (pending) follow(pending);
        return null;
      }}
      onClose={() => setPending(null)}
    />
  );

  return { start, busy, error, dialog };
}
