'use client';

import type { ProjectDetail, ProjectLimits, ProjectSummary } from '@integris/shared';
import {
  Alert,
  Button,
  ButtonLink,
  buildFileTree,
  FileDrop,
  FileTree,
  PageHeader,
  Panel,
  type TreeFile,
} from '@integris/ui';
import {
  ArrowLeft,
  Copy,
  Download,
  FilePen,
  FilePlus,
  FolderPlus,
  Pencil,
  Share2,
  Star,
  Trash2,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { getPathname, useRouter } from '../../i18n/navigation';
import { apiRequest, type ApiResult } from '../../lib/api-client';
import { formatBytes } from '../../lib/format';
import styles from './app.module.css';
import { ConfirmDialog, TextDialog } from './dialogs';
import { useProjectDownload } from './file-ops';
import { useFileTreeActions } from './file-tree-actions';
import { ProjectBadges } from './ProjectBadges';
import { ShareDialog } from '../sharing/ShareDialog';
import { useApiErrorMessage } from './use-api-error';

type Action = { kind: 'rename-project' | 'duplicate' | 'trash' } | null;

/** Project page: name, rights, and the files of the project (screen without mockup). */
export function ProjectFiles({
  initial,
  limits,
}: {
  initial: ProjectDetail;
  limits: ProjectLimits;
}) {
  const t = useTranslations('ProjectPage');
  const tOps = useTranslations('FileOps');
  const locale = useLocale();
  const router = useRouter();
  const message = useApiErrorMessage(locale);
  const [project, setProject] = useState(initial);
  const [shareOpen, setShareOpen] = useState(false);
  const [action, setAction] = useState<Action>(null);
  const download = useProjectDownload(project.id);

  const { edit, manage } = project.rights;
  // Owner and editors download the project, read-only projects included (reading).
  const canDownload = project.role === 'OWNER' || project.role === 'EDITOR';
  const base = `projects/${project.id}`;

  /** Applies an answer carrying the updated project, or returns the error message. */
  const apply = (result: ApiResult<ProjectDetail>) => {
    if (!result.ok) return message(result.error, limits);
    setProject(result.data);
    return null;
  };

  const files = useFileTreeActions({
    project,
    apply,
    canEdit: edit,
    maxFileBytes: limits.maxFileBytes,
    // A new text file opens at once in the editor.
    onCreated: (file) => {
      if (file.kind === 'TEXT') router.push(`/app/projects/${project.id}/edit?file=${file.id}`);
    },
    extraFileItems: (file) =>
      !file.main && file.path.toLowerCase().endsWith('.tex')
        ? [
            {
              id: 'main',
              label: tOps('setMain'),
              icon: Star,
              onSelect: () =>
                void apiRequest<ProjectDetail>('PATCH', base, { mainFilePath: file.path }).then(
                  apply,
                ),
            },
          ]
        : [],
  });

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
        project.folders,
      ),
    [project.files, project.folders, project.mainFilePath, locale],
  );

  const mutate = (method: 'POST' | 'PATCH' | 'DELETE', path: string, body: object = {}) =>
    apiRequest<ProjectDetail>(method, path, body).then(apply);

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
  const current = files.currentFolder ? `${files.currentFolder}/` : tOps('root');

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
            {canDownload && (
              <Button
                variant="secondary"
                busy={download.busy}
                onClick={() => void download.start()}
              >
                <Download size={20} strokeWidth={1.75} aria-hidden="true" />
                {tOps('download')}
              </Button>
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

      {download.error && <Alert tone="error">{download.error}</Alert>}
      {download.dialog}

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
            <>
              <Button variant="secondary" onClick={files.newFile}>
                <FilePlus size={20} strokeWidth={1.75} aria-hidden="true" />
                {tOps('newFile')}
              </Button>
              <Button variant="secondary" onClick={files.newFolder}>
                <FolderPlus size={20} strokeWidth={1.75} aria-hidden="true" />
                {tOps('newFolder')}
              </Button>
            </>
          )
        }
      >
        <div className={styles.stack}>
          <p className={styles.muted}>{t('mainFile', { path: project.mainFilePath })}</p>
          {edit && (
            <>
              <p className={styles.muted}>{tOps('currentFolderIs', { folder: current })}</p>
              <p className={styles.muted}>{tOps('dragHint')}</p>
              <FileDrop
                label={t('uploadChoose')}
                hint={t('uploadHint', {
                  folder: current,
                  max: formatBytes(limits.maxFileBytes, locale),
                  extensions: limits.extensions.join(' '),
                })}
                multiple
                disabled={files.uploading}
                onFiles={(chosen) => files.uploadFiles(chosen, files.currentFolder)}
              />
            </>
          )}
          {files.status}
          <FileTree
            label={t('treeLabel')}
            entries={tree}
            mainLabel={t('main')}
            lockedLabel={t('locked')}
            rootLabel={tOps('root')}
            fileHref={fileHref}
            {...files.treeProps}
          />
        </div>
      </Panel>

      {files.dialogs}
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
    </>
  );
}
