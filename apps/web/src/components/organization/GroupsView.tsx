'use client';

import type { OrgGroup } from '@integris/shared';
import { GROUP_NAME_MAX } from '@integris/shared';
import { Alert, Button, Dialog, Panel, SelectField, TextField } from '@integris/ui';
import { useTranslations } from 'next-intl';
import { type FormEvent, type ReactNode, useState } from 'react';
import { apiRequest, type ClientError } from '../../lib/api-client';
import styles from './org.module.css';
import { useOrgErrorMessage } from './use-org-error';

/**
 * "Classes et filières": nested groups of a BUSINESS (UFR, department, promotion). A group is
 * deleted only when empty (no member, no sub-group).
 */
export function GroupsView({
  organizationId,
  initial,
}: {
  organizationId: string;
  initial: OrgGroup[];
}) {
  const t = useTranslations('Groups');
  const tApp = useTranslations('App');
  const errorMessage = useOrgErrorMessage();
  const [groups, setGroups] = useState(initial);
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const [editing, setEditing] = useState<OrgGroup | null>(null);
  const [editName, setEditName] = useState('');
  const [editParent, setEditParent] = useState('');

  const base = `organizations/${organizationId}/groups`;
  const call = async (
    key: string,
    method: 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: object,
  ) => {
    setBusy(key);
    setError(null);
    const result = await apiRequest<OrgGroup[]>(method, path, body);
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    setGroups(result.data);
    return true;
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (await call('create', 'POST', base, { name, parentId: parentId || null })) setName('');
  };

  const parentOptions = (except?: string) => [
    { value: '', label: t('topLevel') },
    ...groups
      .filter((group) => group.id !== except)
      .map((group) => ({ value: group.id, label: group.name })),
  ];

  const tree = (parent: string | null): ReactNode => {
    const children = groups.filter((group) => group.parentId === parent);
    if (!children.length) return null;
    return (
      <ul className={parent ? styles.tree : styles.list}>
        {children.map((group) => (
          <li key={group.id}>
            <div className={styles.item}>
              <div className={styles.who}>
                <p className={styles.name}>{group.name}</p>
                <p className={styles.muted}>{t('members', { count: group.members })}</p>
              </div>
              <div className={styles.actions}>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setEditing(group);
                    setEditName(group.name);
                    setEditParent(group.parentId ?? '');
                  }}
                >
                  {t('edit')}
                </Button>
                <Button
                  variant="ghost"
                  busy={busy === `delete-${group.id}`}
                  onClick={() => void call(`delete-${group.id}`, 'DELETE', `${base}/${group.id}`)}
                >
                  {t('delete')}
                </Button>
              </div>
            </div>
            {tree(group.id)}
          </li>
        ))}
      </ul>
    );
  };

  return (
    <div className={styles.stack}>
      {error && (
        <Alert tone="error">
          <p>{errorMessage(error)}</p>
        </Alert>
      )}
      <Panel title={t('create')}>
        <form className={styles.form} onSubmit={create}>
          <div className={styles.inline}>
            <TextField
              label={t('name')}
              value={name}
              required
              maxLength={GROUP_NAME_MAX}
              onChange={(event) => setName(event.target.value)}
            />
            <SelectField
              label={t('parent')}
              options={parentOptions()}
              value={parentId}
              onChange={(event) => setParentId(event.target.value)}
            />
            <Button type="submit" busy={busy === 'create'}>
              {t('add')}
            </Button>
          </div>
        </form>
      </Panel>
      <Panel title={t('title', { count: groups.length })}>
        {groups.length ? tree(null) : <p className={styles.muted}>{t('empty')}</p>}
      </Panel>
      <Dialog
        open={editing !== null}
        title={t('editTitle', { name: editing?.name ?? '' })}
        closeLabel={tApp('close')}
        onClose={() => setEditing(null)}
        onSubmit={async () => {
          const done = await call('edit', 'PATCH', `${base}/${editing!.id}`, {
            name: editName,
            parentId: editParent || null,
          });
          if (done) setEditing(null);
        }}
        actions={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              {tApp('cancel')}
            </Button>
            <Button type="submit" busy={busy === 'edit'}>
              {t('save')}
            </Button>
          </>
        }
      >
        <TextField
          label={t('name')}
          value={editName}
          required
          maxLength={GROUP_NAME_MAX}
          onChange={(event) => setEditName(event.target.value)}
        />
        <SelectField
          label={t('parent')}
          options={parentOptions(editing?.id)}
          value={editParent}
          onChange={(event) => setEditParent(event.target.value)}
        />
      </Dialog>
    </div>
  );
}
