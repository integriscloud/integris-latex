'use client';

import type { ProjectList, ProjectSummary } from '@integris/shared';
import { Button, EmptyState, Panel, ProjectList as List, ProjectRow } from '@integris/ui';
import { Trash2 } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { useRouter } from '../../i18n/navigation';
import { apiRequest } from '../../lib/api-client';
import { formatBytes } from '../../lib/format';
import { ConfirmDialog } from './dialogs';
import { useApiErrorMessage } from './use-api-error';

/** Trash: projects kept 30 days, restorable or erasable for good by their owner. */
export function TrashView({ list }: { list: ProjectList }) {
  const t = useTranslations('Trash');
  const locale = useLocale();
  const format = useFormatter();
  const router = useRouter();
  const message = useApiErrorMessage(locale);
  const [action, setAction] = useState<{
    kind: 'restore' | 'erase';
    project: ProjectSummary;
  } | null>(null);

  const run = async () => {
    const { kind, project } = action!;
    const result =
      kind === 'restore'
        ? await apiRequest('POST', `projects/${project.id}/restore`)
        : await apiRequest('DELETE', `projects/${project.id}`);
    if (!result.ok) return message(result.error);
    router.refresh();
    return null;
  };

  if (!list.projects.length) {
    return (
      <Panel>
        <EmptyState icon={Trash2} title={t('emptyTitle')} text={t('emptyText')} />
      </Panel>
    );
  }

  return (
    <Panel title={t('listTitle')}>
      <List label={t('listTitle')}>
        {list.projects.map((project) => (
          <ProjectRow
            key={project.id}
            name={project.name}
            meta={t('meta', {
              deleted: format.dateTime(new Date(project.deletedAt!), { dateStyle: 'medium' }),
              purge: format.dateTime(new Date(project.purgeAt!), { dateStyle: 'medium' }),
              size: formatBytes(project.sizeBytes, locale),
            })}
            actions={
              <>
                <Button variant="secondary" onClick={() => setAction({ kind: 'restore', project })}>
                  {t('restore')}
                </Button>
                <Button variant="ghost" onClick={() => setAction({ kind: 'erase', project })}>
                  {t('erase')}
                </Button>
              </>
            }
          />
        ))}
      </List>
      <ConfirmDialog
        open={action !== null}
        title={action?.kind === 'erase' ? t('eraseTitle') : t('restoreTitle')}
        text={
          action?.kind === 'erase'
            ? t('eraseText', { name: action.project.name })
            : t('restoreText', { name: action?.project.name ?? '' })
        }
        confirmLabel={action?.kind === 'erase' ? t('eraseConfirm') : t('restore')}
        onConfirm={run}
        onClose={() => setAction(null)}
      />
    </Panel>
  );
}
