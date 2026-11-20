'use client';

import {
  ALLOWED_PROJECT_EXTENSIONS,
  allowedExtensionOf,
  checkEntryName,
  extensionOf,
  type NameProblem,
  parentFolder,
  type ProjectDetail,
  type ProjectFileInfo,
} from '@integris/shared';
import {
  Alert,
  Button,
  Dialog,
  type FileTreeEntry,
  type FileTreeFolder,
  type FileTreeProps,
  SelectField,
  TextField,
  type TreeFile,
  type TreeMenuItem,
} from '@integris/ui';
import { FilePlus, FolderInput, FolderPlus, Pencil, Trash2, Upload } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { apiRequest, apiUpload, type ApiResult } from '../../lib/api-client';
import { formatBytes } from '../../lib/format';
import styles from './app.module.css';
import { ConfirmDialog } from './dialogs';
import { MoveDialog, type MovedEntry, movedEntry, requestMove } from './file-ops';
import { useApiErrorMessage } from './use-api-error';

/** What the name dialog does: create in a folder, or rename in place. */
type NameAction =
  { kind: 'new-file' | 'new-folder'; folder: string } | { kind: 'rename'; entry: MovedEntry };

type Notice = { tone: 'success' | 'error'; text: string; lines?: string[] };

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

/** Message of a refused name, with the precise reason. */
function useNameError() {
  const t = useTranslations('NameErrors');
  const tOps = useTranslations('FileOps');
  return (problem: NameProblem, folder: string) => {
    switch (problem.code) {
      case 'name_char':
        // eslint-disable-next-line no-control-regex
        return /^[\u0000-\u001f\u007f]$/.test(problem.char)
          ? t('name_char_invisible')
          : t('name_char', { char: problem.char });
      case 'name_too_long':
      case 'path_too_long':
      case 'path_too_deep':
        return t(problem.code, { max: problem.max });
      case 'name_extension':
        return t('name_extension', {
          extension: problem.extension,
          extensions: problem.extensions.join(' '),
        });
      case 'name_taken':
        return t('name_taken', {
          name: problem.name,
          folder: folder ? `${folder}/` : tOps('rootFolder'),
        });
      default:
        return t(problem.code);
    }
  };
}

export interface FileTreeActionsOptions {
  project: ProjectDetail;
  /** Applies an answer carrying the updated project; returns its error message, if any. */
  apply: (result: ApiResult<ProjectDetail>) => string | null;
  /** Owner or editor on a project that is not read-only. */
  canEdit: boolean;
  maxFileBytes: number;
  /** Folder of the open file: the current folder when none is selected (editor). */
  fallbackFolder?: string;
  /** A text file was just created (the editor opens it). */
  onCreated?: (file: ProjectFileInfo) => void;
  /** More actions on files (project page: main file). */
  extraFileItems?: (file: TreeFile) => TreeMenuItem[];
}

/**
 * Actions on the files of a project, shared by the project page and the editor (screens without
 * mockup): the current folder (selected, or the folder of the open file), the "…" menus of the
 * tree, new file and new folder by name, rename, move, delete and upload into a folder.
 */
export function useFileTreeActions({
  project,
  apply,
  canEdit,
  maxFileBytes,
  fallbackFolder = '',
  onCreated,
  extraFileItems,
}: FileTreeActionsOptions) {
  const t = useTranslations('FileOps');
  const locale = useLocale();
  const message = useApiErrorMessage(locale);
  const nameError = useNameError();
  const [selected, setSelected] = useState<string | null>(null);
  const [nameAction, setNameAction] = useState<NameAction | null>(null);
  const [moving, setMoving] = useState<MovedEntry | null>(null);
  const [deleting, setDeleting] = useState<MovedEntry | null>(null);
  const [replacing, setReplacing] = useState<{ files: File[]; folder: string } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [reveal, setReveal] = useState<string | null>(null);
  const fileInputId = useId();
  const statusId = useId();

  // A result may appear far from where the action started (an upload): brought into view.
  useEffect(() => {
    if (!notice) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document
      .getElementById(statusId)
      ?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  }, [notice, statusId]);
  const [uploadFolder, setUploadFolder] = useState('');

  const base = `projects/${project.id}`;
  const folderExists = (path: string) => path === '' || project.folders.includes(path);
  // A selected folder deleted or moved meanwhile no longer counts.
  const selectedFolder = selected !== null && folderExists(selected) ? selected : null;
  const currentFolder = selectedFolder ?? (folderExists(fallbackFolder) ? fallbackFolder : '');
  const existing = {
    files: project.files.map((file) => file.path),
    folders: project.folders,
  };
  const folderLabel = (folder: string) => (folder ? `${folder}/` : t('rootFolder'));

  const startNew = (kind: 'new-file' | 'new-folder', folder = currentFolder) =>
    setNameAction({ kind, folder });

  const chooseUpload = (folder: string) => {
    setUploadFolder(folder);
    (document.getElementById(fileInputId) as HTMLInputElement | null)?.click();
  };

  // ───────────── Uploads ─────────────

  const upload = async (files: File[], folder: string, replace: ReadonlySet<string>) => {
    setUploading(true);
    setNotice(null);
    const failed: string[] = [];
    let done = 0;
    for (const [index, file] of files.entries()) {
      const path = join(folder, file.name);
      const label = (percent: number) =>
        t('uploading', { index: index + 1, total: files.length, name: file.name, percent });
      setProgress(label(0));
      const refused = !allowedExtensionOf(file.name)
        ? message({ code: 'extension_not_allowed' })
        : file.size > maxFileBytes
          ? message({ code: 'file_too_large' }, { maxFileBytes })
          : null;
      if (refused) {
        failed.push(t('uploadError', { name: file.name, message: refused }));
        continue;
      }
      const result = await apiUpload<ProjectDetail>(
        'PUT',
        `${base}/files/upload?path=${encodeURIComponent(path)}&replace=${replace.has(path)}`,
        file,
        'application/octet-stream',
        (share) => setProgress(label(Math.round(share * 100))),
      );
      const error = apply(result);
      if (error) failed.push(t('uploadError', { name: file.name, message: error }));
      else done++;
    }
    setProgress(null);
    setUploading(false);
    if (done) setReveal(join(folder, files[0]!.name));
    setNotice(
      failed.length
        ? {
            tone: 'error',
            text: `${done ? `${t('uploadDone', { count: done })} ` : ''}${t('uploadErrors', { count: failed.length })}`,
            lines: failed,
          }
        : { tone: 'success', text: t('uploadDone', { count: done }) },
    );
  };

  /** Files chosen or dropped for `folder`: replacing existing ones is confirmed first. */
  const uploadFiles = (files: File[], folder: string) => {
    if (!files.length) return;
    const paths = new Set(project.files.map((file) => file.path));
    if (files.some((file) => paths.has(join(folder, file.name)))) setReplacing({ files, folder });
    else void upload(files, folder, new Set());
  };

  // ───────────── Moves ─────────────

  const move = async (entry: MovedEntry, target: string) => {
    const error = apply(await requestMove(project.id, entry, target));
    const name = nameOf(entry.path);
    if (error) {
      setNotice({ tone: 'error', text: error });
      return error;
    }
    if (entry.type === 'folder' && selected === entry.path) setSelected(join(target, name));
    setReveal(join(target, name));
    setNotice({
      tone: 'success',
      text: target ? t('moved', { name, folder: `${target}/` }) : t('movedRoot', { name }),
    });
    return null;
  };

  const dropMove = (entry: FileTreeEntry, target: string) => {
    if (entry.type === 'file' && entry.file.locked) return;
    void move(movedEntry(entry), target);
  };

  // ───────────── Menus ─────────────

  const folderItems = (folder: string, name: string): TreeMenuItem[] => [
    {
      id: 'new-file',
      label: t('newFileHere'),
      quickLabel: t('quickNewFile', { name }),
      icon: FilePlus,
      quick: true,
      onSelect: () => startNew('new-file', folder),
    },
    {
      id: 'new-folder',
      label: t('newFolderHere'),
      quickLabel: t('quickNewFolder', { name }),
      icon: FolderPlus,
      quick: true,
      onSelect: () => startNew('new-folder', folder),
    },
    { id: 'upload', label: t('uploadHere'), icon: Upload, onSelect: () => chooseUpload(folder) },
  ];

  const folderMenu = (folder: FileTreeFolder): TreeMenuItem[] => {
    const entry: MovedEntry = { type: 'folder', path: folder.path };
    return [
      ...folderItems(folder.path, folder.path),
      {
        id: 'rename',
        label: t('rename'),
        icon: Pencil,
        onSelect: () => setNameAction({ kind: 'rename', entry }),
      },
      { id: 'move', label: t('moveToItem'), icon: FolderInput, onSelect: () => setMoving(entry) },
      {
        id: 'delete',
        label: t('delete'),
        icon: Trash2,
        tone: 'danger',
        onSelect: () => setDeleting(entry),
      },
    ];
  };

  const fileMenu = (file: TreeFile): TreeMenuItem[] => {
    const entry: MovedEntry = { type: 'file', path: file.path, id: file.id };
    return [
      ...(extraFileItems?.(file) ?? []),
      {
        id: 'rename',
        label: t('rename'),
        icon: Pencil,
        disabled: file.locked,
        onSelect: () => setNameAction({ kind: 'rename', entry }),
      },
      {
        id: 'move',
        label: t('moveToItem'),
        icon: FolderInput,
        disabled: file.locked,
        onSelect: () => setMoving(entry),
      },
      {
        id: 'delete',
        label: t('delete'),
        icon: Trash2,
        tone: 'danger',
        disabled: file.locked,
        onSelect: () => setDeleting(entry),
      },
    ];
  };

  const treeProps: Pick<
    FileTreeProps,
    | 'selectedFolder'
    | 'onSelectFolder'
    | 'fileMenu'
    | 'folderMenu'
    | 'rootMenu'
    | 'menuLabel'
    | 'onMove'
    | 'storageKey'
    | 'reveal'
  > = {
    selectedFolder,
    onSelectFolder: setSelected,
    fileMenu: canEdit ? fileMenu : undefined,
    folderMenu: canEdit ? folderMenu : undefined,
    rootMenu: canEdit ? folderItems('', t('rootFolder')) : undefined,
    menuLabel: (name) => t('actionsOf', { name }),
    onMove: canEdit ? dropMove : undefined,
    storageKey: `integris.tree.folded.${project.id}`,
    reveal,
  };

  // ───────────── Dialogs ─────────────

  const submitName = async (action: NameAction, name: string, folder: string) => {
    if (action.kind === 'rename') {
      const { entry } = action;
      const parent = parentFolder(entry.path);
      const check = checkEntryName(name, entry.type, parent, existing, {
        ignore: entry.path,
        defaultExtension: extensionOf(entry.path) ?? undefined,
      });
      if (!check.ok) return nameError(check.problem, parent);
      if (check.path === entry.path) return null;
      const result =
        entry.type === 'file'
          ? await apiRequest<ProjectDetail>('PATCH', `${base}/files/${entry.id}`, {
              path: check.path,
            })
          : await apiRequest<ProjectDetail>('PATCH', `${base}/folders`, {
              from: entry.path,
              to: check.path,
            });
      const error = serverNameError(result, check.name, parent);
      if (error) return error;
      if (entry.type === 'folder' && selected === entry.path) setSelected(check.path);
      setReveal(check.path);
      return null;
    }
    const kind = action.kind === 'new-file' ? 'file' : 'folder';
    const check = checkEntryName(name, kind, folder, existing);
    if (!check.ok) return nameError(check.problem, folder);
    const result =
      kind === 'file'
        ? await apiRequest<ProjectDetail>('POST', `${base}/files`, { path: check.path })
        : await apiRequest<ProjectDetail>('POST', `${base}/folders`, { path: check.path });
    const error = serverNameError(result, check.name, folder);
    if (error) return error;
    setReveal(check.path);
    if (kind === 'folder') setSelected(check.path);
    setNotice({
      tone: 'success',
      text: t('created', { name: check.name, folder: folderLabel(folder) }),
    });
    const created = result.ok ? result.data.files.find((file) => file.path === check.path) : null;
    if (created) onCreated?.(created);
    return null;
  };

  /** Applies the answer; a name taken meanwhile gets the same precise message. */
  const serverNameError = (result: ApiResult<ProjectDetail>, name: string, folder: string) => {
    if (!result.ok && result.error.code === 'path_taken') {
      return nameError({ code: 'name_taken', name }, folder);
    }
    return apply(result);
  };

  const remove = async () => {
    if (!deleting) return null;
    const result =
      deleting.type === 'file'
        ? await apiRequest<ProjectDetail>('DELETE', `${base}/files/${deleting.id}`)
        : await apiRequest<ProjectDetail>('DELETE', `${base}/folders`, { path: deleting.path });
    return apply(result);
  };

  const folderOptions = [
    { value: '', label: t('root') },
    ...project.folders.map((folder) => ({ value: folder, label: `${folder}/` })),
  ];

  const status: ReactNode = (
    // Always present, so screen readers announce what is written into it.
    <div id={statusId} className={styles.stack} aria-live="polite">
      {progress && <p className={styles.progress}>{progress}</p>}
      {notice && (
        <Alert tone={notice.tone} announce={false}>
          {notice.lines ? (
            <>
              <p>{notice.text}</p>
              <ul className={styles.report}>
                {notice.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          ) : (
            notice.text
          )}
        </Alert>
      )}
    </div>
  );

  const dialogs: ReactNode = (
    <>
      <input
        id={fileInputId}
        type="file"
        multiple
        hidden
        accept={ALLOWED_PROJECT_EXTENSIONS.join(',')}
        aria-label={t('uploadInput', { folder: folderLabel(uploadFolder) })}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = '';
          uploadFiles(files, uploadFolder);
        }}
      />
      <NameDialog
        action={nameAction}
        folderOptions={folderOptions}
        onSubmit={submitName}
        onClose={() => setNameAction(null)}
      />
      <MoveDialog
        entry={moving}
        folders={project.folders}
        onMove={move}
        onClose={() => setMoving(null)}
      />
      <ConfirmDialog
        open={deleting !== null}
        title={deleting?.type === 'folder' ? t('deleteFolderTitle') : t('deleteFileTitle')}
        text={
          deleting?.type === 'folder'
            ? t('deleteFolderText', { name: deleting.path })
            : t('deleteFileText', { name: deleting?.path ?? '' })
        }
        confirmLabel={t('delete')}
        onConfirm={remove}
        onClose={() => setDeleting(null)}
      />
      <ConfirmDialog
        open={replacing !== null}
        title={t('replaceTitle')}
        text={t('replaceText')}
        confirmLabel={t('replace')}
        onConfirm={async () => {
          if (!replacing) return null;
          const paths = new Set(replacing.files.map((file) => join(replacing.folder, file.name)));
          void upload(replacing.files, replacing.folder, paths);
          return null;
        }}
        onClose={() => setReplacing(null)}
      />
    </>
  );

  return {
    currentFolder,
    /** null: back to the folder of the open file. */
    selectFolder: setSelected,
    treeProps,
    newFile: () => startNew('new-file'),
    newFolder: () => startNew('new-folder'),
    uploadFiles,
    uploading,
    status,
    dialogs,
    formatSize: (bytes: number) => formatBytes(bytes, locale),
  };
}

/**
 * New file, new folder (a name and the folder to create it in) or rename (a name, same folder).
 * The rule of the name is shown under the field; refusals say their precise reason.
 */
function NameDialog({
  action,
  folderOptions,
  onSubmit,
  onClose,
}: {
  action: NameAction | null;
  folderOptions: { value: string; label: string }[];
  onSubmit: (action: NameAction, name: string, folder: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const t = useTranslations('FileOps');
  const tApp = useTranslations('App');
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Fresh fields each time the dialog opens (state adjusted during render).
  const [shown, setShown] = useState(action);
  if (action !== shown) {
    setShown(action);
    if (action) {
      setName(action.kind === 'rename' ? nameOf(action.entry.path) : '');
      setFolder(action.kind === 'rename' ? '' : action.folder);
      setError(null);
    }
  }

  const submit = async () => {
    if (!action) return;
    setBusy(true);
    const problem = await onSubmit(action, name, folder);
    setBusy(false);
    if (problem) setError(problem);
    else onClose();
  };

  const isFile =
    action?.kind === 'new-file' || (action?.kind === 'rename' && action.entry.type === 'file');
  const title =
    action?.kind === 'rename'
      ? t('renameTitle', { name: action.entry.path })
      : action?.kind === 'new-folder'
        ? t('newFolderTitle')
        : t('newFileTitle');
  const help = !isFile
    ? t('folderNameHelp')
    : action?.kind === 'rename'
      ? t('renameFileHelp', { extension: extensionOf(action.entry.path) ?? '.tex' })
      : t('fileNameHelp', { extensions: ALLOWED_PROJECT_EXTENSIONS.join(' ') });

  return (
    <Dialog
      open={action !== null}
      title={title}
      closeLabel={tApp('close')}
      onClose={onClose}
      onSubmit={submit}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            {tApp('cancel')}
          </Button>
          <Button type="submit" busy={busy}>
            {action?.kind === 'rename' ? t('save') : t('create')}
          </Button>
        </>
      }
    >
      <TextField
        label={t('name')}
        help={help}
        error={error ?? undefined}
        value={name}
        maxLength={300}
        autoFocus
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          setName(event.target.value);
          setError(null);
        }}
      />
      {action && action.kind !== 'rename' && (
        <SelectField
          label={t('inFolder')}
          value={folder}
          options={folderOptions}
          onChange={(event) => {
            setFolder(event.target.value);
            setError(null);
          }}
        />
      )}
    </Dialog>
  );
}
