'use client';

import { formatJoinCode, type OrganizationView } from '@integris/shared';
import { Alert, Button, ButtonLink, Checkbox, Dialog, Panel, SelectField } from '@integris/ui';
import { RefreshCw } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { getPathname } from '../../i18n/navigation';
import { apiPost, apiRequest, type ClientError } from '../../lib/api-client';
import styles from './org.module.css';
import { useOrgErrorMessage } from './use-org-error';

/**
 * Organization home (mockup etablissement-01, rebuilt plain): seats bought, held, reserved,
 * waiting 30 days and free; members by kind; join requests; renewal; the teachers' join code.
 * A plain member sees the organization and can leave it.
 */
export function OrgOverview({ initial }: { initial: OrganizationView }) {
  const t = useTranslations('Organization');
  const tApp = useTranslations('App');
  const locale = useLocale();
  const format = useFormatter();
  const errorMessage = useOrgErrorMessage();
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  const [leaving, setLeaving] = useState(false);
  const href = (path: string) => getPathname({ href: path, locale });
  const date = (iso: string) =>
    format.dateTime(new Date(iso), { day: 'numeric', month: 'long', year: 'numeric' });

  const regenerate = async () => {
    setBusy(true);
    setError(null);
    const result = await apiPost<OrganizationView>(`organizations/${view.id}/join-code`);
    setBusy(false);
    if (result.ok) setView(result.data);
    else setError(result.error);
  };

  const update = async (path: string, body: object) => {
    setBusy(true);
    setError(null);
    const result = await apiRequest<OrganizationView>(
      'PATCH',
      `organizations/${view.id}/${path}`,
      body,
    );
    setBusy(false);
    if (result.ok) setView(result.data);
    else setError(result.error);
  };

  const leave = async () => {
    setBusy(true);
    setError(null);
    const result = await apiPost(`organizations/${view.id}/leave`);
    if (result.ok) {
      await apiPost('auth/space', { spaceId: 'personal' });
      window.location.assign(href('/app'));
      return;
    }
    setBusy(false);
    setLeaving(false);
    setError(result.error);
  };

  return (
    <div className={styles.stack}>
      {error && (
        <Alert tone="error">
          <p>{errorMessage(error)}</p>
        </Alert>
      )}
      {!view.subscription.live && (
        <Alert tone="warning">
          <p>{t('inactive')}</p>
        </Alert>
      )}
      {view.seats && view.counts && (
        <Panel
          title={t('seats.title')}
          actions={
            view.me.role === 'OWNER' && (
              <ButtonLink
                href={`${href('/app/billing/checkout')}?seats=${view.subscription.id}`}
                variant="secondary"
              >
                {t('seats.add')}
              </ButtonLink>
            )
          }
        >
          <dl className={styles.stats}>
            <div className={styles.stat}>
              <dt>{t('seats.used')}</dt>
              <dd>{t('seats.usedOf', { used: view.seats.held, total: view.seats.total })}</dd>
            </div>
            <div className={styles.stat}>
              <dt>{t('seats.reserved')}</dt>
              <dd>{view.seats.reserved}</dd>
            </div>
            <div className={styles.stat}>
              <dt>{t('seats.waiting')}</dt>
              <dd>{view.seats.waiting}</dd>
            </div>
            <div className={styles.stat}>
              <dt>{t('seats.free')}</dt>
              <dd>{view.seats.free}</dd>
            </div>
          </dl>
          {view.seats.nextFreeAt && (
            <p className={styles.muted}>
              {t('seats.nextFree', { date: date(view.seats.nextFreeAt) })}
            </p>
          )}
          {view.seats.free === 0 && <p className={styles.muted}>{t('seats.full')}</p>}
        </Panel>
      )}
      {view.counts && (
        <Panel
          title={t('members.title')}
          actions={
            <ButtonLink href={href('/app/org/members')} variant="secondary">
              {t('members.manage')}
            </ButtonLink>
          }
        >
          <dl className={styles.stats}>
            {view.type === 'BUSINESS' ? (
              <>
                <div className={styles.stat}>
                  <dt>{t('members.teachers')}</dt>
                  <dd>{view.counts.teachers}</dd>
                </div>
                <div className={styles.stat}>
                  <dt>{t('members.students')}</dt>
                  <dd>{view.counts.students}</dd>
                </div>
              </>
            ) : (
              <div className={styles.stat}>
                <dt>{t('members.all')}</dt>
                <dd>{view.counts.others}</dd>
              </div>
            )}
            <div className={styles.stat}>
              <dt>{t('members.invitations')}</dt>
              <dd>{view.counts.invitations}</dd>
            </div>
            {view.type === 'BUSINESS' && (
              <div className={styles.stat}>
                <dt>{t('members.joinRequests')}</dt>
                <dd>{view.counts.joinRequests}</dd>
              </div>
            )}
          </dl>
          {view.admins && (
            <p className={styles.muted}>
              {t('members.admins', { count: view.admins.count, max: view.admins.max })}
            </p>
          )}
        </Panel>
      )}
      {view.joinCode && (
        <Panel
          title={t('joinCode.title')}
          actions={
            <Button variant="secondary" busy={busy} onClick={() => void regenerate()}>
              <RefreshCw size={20} strokeWidth={1.75} aria-hidden="true" />
              {t('joinCode.regenerate')}
            </Button>
          }
        >
          <p className={styles.code}>{formatJoinCode(view.joinCode.replace('-', ''))}</p>
          <p className={styles.muted}>{t('joinCode.help')}</p>
        </Panel>
      )}
      <Panel title={t('subscription.title')}>
        <p className={styles.muted}>
          {t('subscription.text', {
            plan: t(`plans.${view.subscription.planCode}`),
            date: date(view.subscription.periodEnd),
          })}
        </p>
        {view.me.role === 'OWNER' && (
          <div className={styles.actions}>
            <ButtonLink href={href('/app/billing')} variant="secondary">
              {t('subscription.manage')}
            </ButtonLink>
          </div>
        )}
      </Panel>
      {view.type === 'BUSINESS' && view.me.manages && (
        <Panel title={t('settings.title')}>
          <Checkbox
            checked={view.membersChooseGroup}
            disabled={busy}
            onChange={(event) =>
              void update('settings', { membersChooseGroup: event.target.checked })
            }
          >
            {t('settings.membersChooseGroup')}
          </Checkbox>
          <p className={styles.muted}>{t('settings.membersChooseGroupHelp')}</p>
        </Panel>
      )}
      {view.membersChooseGroup && view.groups && (
        <Panel title={t('myGroup.title')}>
          <SelectField
            label={t('myGroup.label')}
            options={[
              { value: '', label: t('myGroup.none') },
              ...view.groups.map((group) => ({ value: group.id, label: group.name })),
            ]}
            value={view.me.groupId ?? ''}
            disabled={busy}
            onChange={(event) => void update('my-group', { groupId: event.target.value || null })}
          />
        </Panel>
      )}
      {view.type === 'BUSINESS' && view.me.kind === 'STUDENT' && (
        <Panel title={t('becomeTeacher.title')}>
          {view.me.teacherRequested ? (
            <p className={styles.muted}>{t('becomeTeacher.pending')}</p>
          ) : (
            <>
              <p className={styles.muted}>{t('becomeTeacher.text')}</p>
              <div className={styles.actions}>
                <ButtonLink href={href('/app/join-organization')} variant="secondary">
                  {t('becomeTeacher.button')}
                </ButtonLink>
              </div>
            </>
          )}
        </Panel>
      )}
      {view.me.role !== 'OWNER' && (
        <Panel title={t('leave.title')}>
          <p className={styles.muted}>{t('leave.text')}</p>
          <div className={styles.actions}>
            <Button variant="secondary" onClick={() => setLeaving(true)}>
              {t('leave.button')}
            </Button>
          </div>
        </Panel>
      )}
      <Dialog
        open={leaving}
        title={t('leave.confirmTitle', { name: view.name })}
        closeLabel={tApp('close')}
        onClose={() => setLeaving(false)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setLeaving(false)}>
              {tApp('cancel')}
            </Button>
            <Button busy={busy} onClick={() => void leave()}>
              {t('leave.confirm')}
            </Button>
          </>
        }
      >
        <p>{t('leave.confirmText')}</p>
      </Dialog>
    </div>
  );
}
