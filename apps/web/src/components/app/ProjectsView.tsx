'use client';

import type { ProjectList, ProjectSummary } from '@integris/shared';
import {
  ButtonLink,
  EmptyState,
  IconButton,
  Panel,
  ProjectList as List,
  ProjectRow,
} from '@integris/ui';
import { Copy, FolderPlus, Pencil, Search, Trash2 } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { getPathname, useRouter } from '../../i18n/navigation';
import { apiRequest } from '../../lib/api-client';
import { formatBytes } from '../../lib/format';
import { ConfirmDialog, TextDialog } from './dialogs';
import styles from './app.module.css';
import { ProjectBadges } from './ProjectBadges';
import { useApiErrorMessage } from './use-api-error';

type Action = { kind: 'rename' | 'duplicate' | 'trash'; project: ProjectSummary } | null;

/**
 * "Mes projets": owned and shared projects, with search and the owner's actions. `now` is the time
 * of the server rendering, so relative dates read the same on the server and in the browser.
 */
export function ProjectsView({ list, now }: { list: ProjectList; now: string }) {
  const t = useTranslations('Projects');
  const locale = useLocale();
  const format = useFormatter();
  const router = useRouter();
  const message = useApiErrorMessage(locale);
  const [query, setQuery] = useState('');
  const [action, setAction] = useState<Action>(null);

  const shown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(locale);
    return needle
      ? list.projects.filter((project) => project.name.toLocaleLowerCase(locale).includes(needle))
      : list.projects;
  }, [list.projects, query, locale]);

  const href = (target: string) => getPathname({ href: target, locale });
  const done = () => router.refresh();

  const rename = async (name: string) => {
    const result = await apiRequest('PATCH', `projects/${action!.project.id}`, { name });
    if (!result.ok) return message(result.error);
    done();
    return null;
  };

  const duplicate = async (name: string) => {
    const result = await apiRequest<ProjectSummary>(
      'POST',
      `projects/${action!.project.id}/duplicate`,
      { name },
    );
    if (!result.ok) return message(result.error);
    done();
    return null;
  };

  const trash = async () => {
    const result = await apiRequest('POST', `projects/${action!.project.id}/trash`);
    if (!result.ok) return message(result.error);
    done();
    return null;
  };

  if (!list.projects.length) {
    return (
      <Panel>
        <EmptyState
          icon={FolderPlus}
          title={t('emptyTitle')}
          text={t('emptyText')}
          action={<ButtonLink href={href('/app/new')}>{t('new')}</ButtonLink>}
        />
      </Panel>
    );
  }

  return (
    <Panel
      title={t('listTitle')}
      actions={
        <label className={styles.search}>
          <Search size={20} strokeWidth={1.75} aria-hidden="true" />
          <input
            type="search"
            className={styles.searchInput}
            aria-label={t('search')}
            placeholder={t('search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      }
    >
      {shown.length ? (
        <List label={t('listTitle')}>
          {shown.map((project) => (
            <ProjectRow
              key={project.id}
              name={project.name}
              href={href(`/app/projects/${project.id}`)}
              meta={t('meta', {
                when: format.relativeTime(new Date(project.lastActivityAt), new Date(now)),
                size: formatBytes(project.sizeBytes, locale),
              })}
              people={
                project.role === 'OWNER' ? undefined : t('sharedBy', { name: project.ownerName })
              }
              badge={<ProjectBadges role={project.role} readOnly={project.readOnly} />}
              actions={
                <>
                  <ButtonLink href={href(`/app/projects/${project.id}`)} variant="secondary">
                    {t('open')}
                  </ButtonLink>
                  {project.role === 'OWNER' && (
                    <>
                      <IconButton
                        icon={Pencil}
                        label={t('renameOf', { name: project.name })}
                        onClick={() => setAction({ kind: 'rename', project })}
                      />
                      <IconButton
                        icon={Copy}
                        label={t('duplicateOf', { name: project.name })}
                        onClick={() => setAction({ kind: 'duplicate', project })}
                      />
                      <IconButton
                        icon={Trash2}
                        tone="danger"
                        label={t('trashOf', { name: project.name })}
                        onClick={() => setAction({ kind: 'trash', project })}
                      />
                    </>
                  )}
                </>
              }
            />
          ))}
        </List>
      ) : (
        <p className={styles.muted}>{t('noMatch')}</p>
      )}

      <TextDialog
        open={action?.kind === 'rename'}
        title={t('renameTitle')}
        label={t('name')}
        initial={action?.project.name ?? ''}
        submitLabel={t('rename')}
        onSubmit={rename}
        onClose={() => setAction(null)}
      />
      <TextDialog
        open={action?.kind === 'duplicate'}
        title={t('duplicateTitle')}
        label={t('name')}
        initial={action ? t('copyName', { name: action.project.name }) : ''}
        submitLabel={t('duplicate')}
        onSubmit={duplicate}
        onClose={() => setAction(null)}
      />
      <ConfirmDialog
        open={action?.kind === 'trash'}
        title={t('trashTitle')}
        text={t('trashText', { name: action?.project.name ?? '' })}
        confirmLabel={t('trash')}
        onConfirm={trash}
        onClose={() => setAction(null)}
      />
    </Panel>
  );
}
