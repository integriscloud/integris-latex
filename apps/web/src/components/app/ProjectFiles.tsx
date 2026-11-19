'use client';

import {
  allowedExtensionOf,
  type ProjectDetail,
  type ProjectLimits,
  type ProjectSummary,
} from '@integris/shared';
import {
  Alert,
  Button,
  ButtonLink,
  buildFileTree,
  FileDrop,
  type FileTreeFolder,
  FileTree,
  IconButton,
  PageHeader,
  Panel,
  type TreeFile,
} from '@integris/ui';
import { ArrowLeft, Copy, FilePlus, FilePen, Pencil, Share2, Star, Trash2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getPathname, useRouter } from '../../i18n/navigation';
import { apiRequest, apiUpload, type ApiResult } from '../../lib/api-client';
import { formatBytes } from '../../lib/format';
import styles from './app.module.css';
import { ConfirmDialog, TextDialog } from './dialogs';
import { ProjectBadges } from './ProjectBadges';
import { ShareDialog } from '../sharing/ShareDialog';
import { useApiErrorMessage } from './use-api-error';

type Action =
  | { kind: 'rename-project' | 'duplicate' | 'trash' | 'new-file' }
  | { kind: 'move-file' | 'delete-file'; file: TreeFile }
  | { kind: 'move-folder' | 'delete-folder'; folder: FileTreeFolder }
  | { kind: 'replace'; files: File[]; folder: string }
  | null;

const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

/** Project page: name, rights, and the files of the project (screen without mockup). */
export function ProjectFiles({
  initial,
  limits,
}: {
  initial: ProjectDetail;
  limits: ProjectLimits;
}) {
  const t = useTranslations('ProjectPage');
  const locale = useLocale();
  const router = useRouter();
  const message = useApiErrorMessage(locale);
  const [project, setProject] = useState(initial);
  const [shareOpen, setShareOpen] = useState(false);
  const [action, setAction] = useState<Action>(null);
  const [folder, setFolder] = useState('');
  const [progress, setProgress] = useState<string | null>(null);
  /** Result of the last upload: files sent, and the refusals with their reason. */
  const [report, setReport] = useState<{ done: number; failed: string[] } | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  // The result appears under the drop zone, often below the fold: bring it into view.
  useEffect(() => {
    if (!report) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    resultRef.current?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  }, [report]);
  const [busy, setBusy] = useState(false);

  const { edit, manage } = project.rights;
  const base = `projects/${project.id}`;

  const tree = useMemo(
    () =>
      buildFileTree(
        project.files.map((file) => ({
          id: file.id,
          path: file.path,
          size: formatBytes(file.sizeBytes, locale),
          main: file.path === project.mainFilePath,
          locked: file.locked,
        })),
      ),
    [project.files, project.mainFilePath, locale],
  );

  const folders = useMemo(() => {
    const set = new Set<string>();
    for (const file of project.files) {
      const parts = file.path.split('/').slice(0, -1);
      parts.forEach((_, index) => set.add(parts.slice(0, index + 1).join('/')));
    }
    return [...set].sort();
  }, [project.files]);

  /** Applies an answer carrying the updated project, or returns the error message. */
  const apply = (result: ApiResult<ProjectDetail>) => {
    if (!result.ok) return message(result.error, limits);
    setProject(result.data);
    return null;
  };

  const upload = async (files: File[], target: string, replace: Set<string>) => {
    setBusy(true);
    setReport(null);
    const failed: string[] = [];
    let done = 0;
    for (const [index, file] of files.entries()) {
      const path = join(target, file.name);
      const label = (percent: number) =>
        t('uploading', { index: index + 1, total: files.length, name: file.name, percent });
      setProgress(label(0));
      if (!allowedExtensionOf(file.name)) {
        failed.push(
          t('uploadError', {
            name: file.name,
            message: message({ code: 'extension_not_allowed' }, limits),
          }),
        );
        continue;
      }
      if (file.size > limits.maxFileBytes) {
        failed.push(
          t('uploadError', {
            name: file.name,
            message: message({ code: 'file_too_large' }, limits),
          }),
        );
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
    setReport({ done, failed });
    setBusy(false);
  };

  const chooseFiles = (files: File[]) => {
    const existing = new Set(project.files.map((file) => file.path));
    const clashes = files.filter((file) => existing.has(join(folder, file.name)));
    if (clashes.length) setAction({ kind: 'replace', files, folder });
    else void upload(files, folder, new Set());
  };

  const mutate = (method: 'POST' | 'PATCH' | 'DELETE', path: string, body: object = {}) =>
    apiRequest<ProjectDetail>(method, path, body).then(apply);

  const fileActions = (file: TreeFile) =>
    edit && (
      <>
        {!file.main && file.path.toLowerCase().endsWith('.tex') && (
          <IconButton
            icon={Star}
            label={t('setMain', { name: file.path })}
            onClick={() => void mutate('PATCH', base, { mainFilePath: file.path })}
          />
        )}
        <IconButton
          icon={Pencil}
          label={t('moveFile', { name: file.path })}
          disabled={file.locked}
          onClick={() => setAction({ kind: 'move-file', file })}
        />
        <IconButton
          icon={Trash2}
          tone="danger"
          label={t('deleteFile', { name: file.path })}
          disabled={file.locked}
          onClick={() => setAction({ kind: 'delete-file', file })}
        />
      </>
    );

  const folderActions = (entry: FileTreeFolder) =>
    edit && (
      <>
        <IconButton
          icon={Pencil}
          label={t('moveFolder', { name: entry.path })}
          onClick={() => setAction({ kind: 'move-folder', folder: entry })}
        />
        <IconButton
          icon={Trash2}
          tone="danger"
          label={t('deleteFolder', { name: entry.path })}
          onClick={() => setAction({ kind: 'delete-folder', folder: entry })}
        />
      </>
    );

  const close = () => setAction(null);
  const projectsHref = getPathname({ href: '/app', locale });
  // The editor is a separate root layout (fonts of the editor only): plain links, full load.
  const editorHref = getPathname({ href: `/app/projects/${project.id}/edit`, locale });
  const textFiles = useMemo(
    () => new Set(project.files.filter((file) => file.kind === 'TEXT').map((file) => file.id)),
    [project.files],
  );
  const fileHref = (file: TreeFile) =>
    textFiles.has(file.id) ? `${editorHref}?file=${encodeURIComponent(file.id)}` : undefined;

  return (
    <>
      <PageHeader
        back={
          <a className={styles.back} href={projectsHref}>
            <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
            {t('back')}
          </a>
        }
        title={project.name}
        subtitle={
          <span className={styles.row}>
            <ProjectBadges role={project.role} readOnly={project.readOnly} />
            {project.role !== 'OWNER' && t('ownedBy', { name: project.ownerName })}
          </span>
        }
        actions={
          <>
            {textFiles.size > 0 && (
              <ButtonLink href={editorHref}>
                <FilePen size={20} strokeWidth={1.75} aria-hidden="true" />
                {t('open')}
              </ButtonLink>
            )}
            <Button variant="secondary" onClick={() => setShareOpen(true)}>
              <Share2 size={20} strokeWidth={1.75} aria-hidden="true" />
              {t('share')}
            </Button>
            {manage && (
              <>
                <Button variant="secondary" onClick={() => setAction({ kind: 'rename-project' })}>
                  <Pencil size={20} strokeWidth={1.75} aria-hidden="true" />
                  {t('rename')}
                </Button>
                <Button variant="secondary" onClick={() => setAction({ kind: 'duplicate' })}>
                  <Copy size={20} strokeWidth={1.75} aria-hidden="true" />
                  {t('duplicate')}
                </Button>
                <Button variant="secondary" onClick={() => setAction({ kind: 'trash' })}>
                  <Trash2 size={20} strokeWidth={1.75} aria-hidden="true" />
                  {t('trash')}
                </Button>
              </>
            )}
          </>
        }
      />

      <ShareDialog
        projectId={project.id}
        projectName={project.name}
        open={shareOpen}
        onClose={() => setShareOpen(false)}
      />

      {!edit && (
        <Alert tone="info">
          {project.readOnly
            ? t('readOnlyProject')
            : project.rights.comment
              ? t('readOnlyCommenter')
              : t('readOnlyRole')}
        </Alert>
      )}

      <Panel
        title={t('files', { count: project.files.length })}
        actions={
          edit && (
            <Button variant="secondary" onClick={() => setAction({ kind: 'new-file' })}>
              <FilePlus size={20} strokeWidth={1.75} aria-hidden="true" />
              {t('newFile')}
            </Button>
          )
        }
      >
        <p className={styles.muted}>{t('mainFile', { path: project.mainFilePath })}</p>
        <FileTree
          label={t('treeLabel')}
          entries={tree}
          mainLabel={t('main')}
          lockedLabel={t('locked')}
          renderFileActions={fileActions}
          renderFolderActions={folderActions}
          fileHref={fileHref}
        />
      </Panel>

      {edit && (
        <Panel title={t('uploadTitle')}>
          <div className={styles.stack}>
            {folders.length > 0 && (
              <label className={styles.row}>
                <span className={styles.label}>{t('destination')}</span>
                <select
                  className={styles.select}
                  value={folder}
                  onChange={(event) => setFolder(event.target.value)}
                >
                  <option value="">{t('root')}</option>
                  {folders.map((path) => (
                    <option key={path} value={path}>
                      {path}/
                    </option>
                  ))}
                </select>
              </label>
            )}
            <FileDrop
              label={t('uploadChoose')}
              hint={t('uploadHint', {
                max: formatBytes(limits.maxFileBytes, locale),
                extensions: limits.extensions.join(' '),
              })}
              multiple
              disabled={busy}
              onFiles={chooseFiles}
            />
            {/* Always present, so screen readers announce what is written into it. */}
            <div ref={resultRef} className={styles.stack} aria-live="polite">
              {progress && <p className={styles.progress}>{progress}</p>}
              {report && report.done > 0 && (
                <Alert tone="success" announce={false}>
                  {t('uploadDone', { count: report.done })}
                </Alert>
              )}
              {report && report.failed.length > 0 && (
                <Alert tone="error" announce={false}>
                  {t('uploadErrors', { count: report.failed.length })}
                  <ul className={styles.report}>
                    {report.failed.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </Alert>
              )}
            </div>
          </div>
        </Panel>
      )}

      <TextDialog
        open={action?.kind === 'rename-project'}
        title={t('renameTitle')}
        label={t('name')}
        initial={project.name}
        submitLabel={t('rename')}
        onSubmit={(name) => mutate('PATCH', base, { name })}
        onClose={close}
      />
      <TextDialog
        open={action?.kind === 'duplicate'}
        title={t('duplicateTitle')}
        label={t('name')}
        initial={t('copyName', { name: project.name })}
        submitLabel={t('duplicate')}
        onSubmit={async (name) => {
          const result = await apiRequest<ProjectSummary>('POST', `${base}/duplicate`, { name });
          if (!result.ok) return message(result.error, limits);
          router.push(`/app/projects/${result.data.id}`);
          return null;
        }}
        onClose={close}
      />
      <ConfirmDialog
        open={action?.kind === 'trash'}
        title={t('trashTitle')}
        text={t('trashText', { name: project.name })}
        confirmLabel={t('trash')}
        onConfirm={async () => {
          const result = await apiRequest('POST', `${base}/trash`);
          if (!result.ok) return message(result.error);
          router.push('/app');
          return null;
        }}
        onClose={close}
      />
      <TextDialog
        open={action?.kind === 'new-file'}
        title={t('newFileTitle')}
        label={t('path')}
        help={t('newFileHelp')}
        initial={folder ? `${folder}/` : ''}
        submitLabel={t('create')}
        onSubmit={(path) => mutate('POST', `${base}/files`, { path })}
        onClose={close}
      />
      <TextDialog
        open={action?.kind === 'move-file'}
        title={t('moveFileTitle')}
        label={t('path')}
        help={t('moveHelp')}
        initial={action?.kind === 'move-file' ? action.file.path : ''}
        submitLabel={t('save')}
        onSubmit={(path) =>
          action?.kind === 'move-file'
            ? mutate('PATCH', `${base}/files/${action.file.id}`, { path })
            : Promise.resolve(null)
        }
        onClose={close}
      />
      <TextDialog
        open={action?.kind === 'move-folder'}
        title={t('moveFolderTitle')}
        label={t('path')}
        initial={action?.kind === 'move-folder' ? action.folder.path : ''}
        submitLabel={t('save')}
        onSubmit={(to) =>
          action?.kind === 'move-folder'
            ? mutate('PATCH', `${base}/folders`, { from: action.folder.path, to })
            : Promise.resolve(null)
        }
        onClose={close}
      />
      <ConfirmDialog
        open={action?.kind === 'delete-file'}
        title={t('deleteFileTitle')}
        text={t('deleteFileText', { name: action?.kind === 'delete-file' ? action.file.path : '' })}
        confirmLabel={t('delete')}
        onConfirm={() =>
          action?.kind === 'delete-file'
            ? mutate('DELETE', `${base}/files/${action.file.id}`)
            : Promise.resolve(null)
        }
        onClose={close}
      />
      <ConfirmDialog
        open={action?.kind === 'delete-folder'}
        title={t('deleteFolderTitle')}
        text={t('deleteFolderText', {
          name: action?.kind === 'delete-folder' ? action.folder.path : '',
        })}
        confirmLabel={t('delete')}
        onConfirm={() =>
          action?.kind === 'delete-folder'
            ? mutate('DELETE', `${base}/folders`, { path: action.folder.path })
            : Promise.resolve(null)
        }
        onClose={close}
      />
      <ConfirmDialog
        open={action?.kind === 'replace'}
        title={t('replaceTitle')}
        text={t('replaceText')}
        confirmLabel={t('replace')}
        onConfirm={async () => {
          if (action?.kind !== 'replace') return null;
          const paths = new Set(action.files.map((file) => join(action.folder, file.name)));
          void upload(action.files, action.folder, paths);
          return null;
        }}
        onClose={close}
      />
    </>
  );
}
