'use client';

import type { OrgGroup } from '@integris/shared';
import { Button, Checkbox, Dialog } from '@integris/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import styles from './org.module.css';

/** Full name of a group, parents first ("UFR SVT › Licence 3"). */
export function groupLabel(groups: OrgGroup[], id: string): string {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const names: string[] = [];
  let current = byId.get(id);
  while (current && names.length < 20) {
    names.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return names.join(' › ');
}

/**
 * Groups ("Classes et filières") a secretariat serves: one or more, each with its subgroups
 * (docs/spec.md, "Devoirs et secrétariat").
 */
export function ScopeGroupsField({
  groups,
  value,
  onChange,
  invalid,
}: {
  groups: OrgGroup[];
  value: string[];
  onChange: (value: string[]) => void;
  invalid?: boolean;
}) {
  const t = useTranslations('Members.secretariat');
  const sorted = [...groups].sort((a, b) =>
    groupLabel(groups, a.id).localeCompare(groupLabel(groups, b.id)),
  );
  return (
    <fieldset className={styles.scopes}>
      <legend className={styles.name}>{t('legend')}</legend>
      <p className={styles.muted}>{t('help')}</p>
      {sorted.length ? (
        sorted.map((group) => (
          <Checkbox
            key={group.id}
            checked={value.includes(group.id)}
            invalid={invalid}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...value, group.id]
                  : value.filter((item) => item !== group.id),
              )
            }
          >
            {groupLabel(groups, group.id)}
          </Checkbox>
        ))
      ) : (
        <p className={styles.muted}>{t('noGroups')}</p>
      )}
      {invalid && (
        <p className={styles.fieldError} role="alert">
          {t('required')}
        </p>
      )}
    </fieldset>
  );
}

/** Dialog choosing the groups of a secretariat member (new profile, or a change of groups). */
export function ScopeGroupsDialog({
  open,
  name,
  groups,
  initial,
  busy,
  onClose,
  onSave,
}: {
  open: boolean;
  name: string;
  groups: OrgGroup[];
  initial: string[];
  busy: boolean;
  onClose: () => void;
  onSave: (groupIds: string[]) => void;
}) {
  const t = useTranslations('Members.secretariat');
  const tApp = useTranslations('App');
  const [value, setValue] = useState(initial);
  const [tried, setTried] = useState(false);
  const [shownFor, setShownFor] = useState<string | null>(null);
  // Starts again from the member's groups each time the dialog opens for someone.
  const key = open ? `${name}:${initial.join(',')}` : null;
  if (key !== shownFor) {
    setShownFor(key);
    setValue(initial);
    setTried(false);
  }
  return (
    <Dialog
      open={open}
      title={t('dialogTitle', { name })}
      closeLabel={tApp('close')}
      onClose={onClose}
      onSubmit={() => {
        setTried(true);
        if (value.length) onSave(value);
      }}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            {tApp('cancel')}
          </Button>
          <Button type="submit" busy={busy}>
            {t('save')}
          </Button>
        </>
      }
    >
      <ScopeGroupsField
        groups={groups}
        value={value}
        onChange={setValue}
        invalid={tried && !value.length}
      />
    </Dialog>
  );
}
