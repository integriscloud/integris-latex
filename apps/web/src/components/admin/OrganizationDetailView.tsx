'use client';

import type { AdminOrgDetail } from '@integris/shared';
import { Alert, Badge, Button, Panel, TextAreaField, TextField } from '@integris/ui';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { getPathname } from '../../i18n/navigation';
import { apiPost, type ClientError } from '../../lib/api-client';
import { useAdminAction } from './admin-actions';
import styles from './admin.module.css';
import { useAdminErrorMessage } from './use-admin-error';

/** An organization in the back-office: subscription, seats, members (no project), pilot trial. */
export function OrganizationDetailView({ initial }: { initial: AdminOrgDetail }) {
  const t = useTranslations('Admin.organization');
  const format = useFormatter();
  const locale = useLocale();
  const run = useAdminAction();
  const errorMessage = useAdminErrorMessage();
  const [detail, setDetail] = useState(initial);
  const [days, setDays] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  const [extended, setExtended] = useState(false);
  const { organization, trial } = detail;
  const subscription = organization.subscription;
  const date = (value: string) => format.dateTime(new Date(value), { dateStyle: 'long' });

  const extend = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setExtended(false);
    const result = await run(() =>
      apiPost<AdminOrgDetail>(`admin/organizations/${organization.id}/trial-extension`, {
        days: Number(days),
        reason,
      }),
    );
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setDetail(result.data);
    setDays('');
    setReason('');
    setExtended(true);
  };

  return (
    <div className={styles.stack}>
      <Panel title={t('subscriptionTitle')}>
        <dl className={styles.facts}>
          <dt>{t('type')}</dt>
          <dd>
            {organization.type}{' '}
            {organization.pilotTrial && <Badge tone="accent">{t('pilot')}</Badge>}
          </dd>
          <dt>{t('owner')}</dt>
          <dd>{organization.ownerName ?? '—'}</dd>
          <dt>{t('ifu')}</dt>
          <dd>{organization.ifu ?? '—'}</dd>
          {subscription && (
            <>
              <dt>{t('plan')}</dt>
              <dd>
                {t('planValue', {
                  plan: subscription.planCode,
                  status: subscription.status,
                  period: subscription.billingPeriod,
                  version: subscription.planVersion ?? 0,
                })}
              </dd>
              <dt>{t('period')}</dt>
              <dd>
                {t('periodValue', {
                  start: date(subscription.currentPeriodStart),
                  end: date(subscription.currentPeriodEnd),
                })}
              </dd>
            </>
          )}
          <dt>{t('seats')}</dt>
          <dd>{t('seatsValue', { used: detail.seats.used, total: detail.seats.total })}</dd>
        </dl>
      </Panel>

      {trial && (
        <Panel title={t('trialTitle')}>
          <form className={styles.form} onSubmit={extend}>
            <p className={styles.muted}>
              {t('trialText', {
                start: date(trial.startedAt),
                end: date(trial.endsAt),
                days: trial.extendableDays,
              })}
            </p>
            {trial.extendableDays > 0 ? (
              <>
                <div className={styles.fields}>
                  <TextField
                    label={t('days')}
                    help={t('daysHelp', { max: trial.extendableDays })}
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={days}
                    required
                    onChange={(event) => setDays(event.target.value.trim())}
                  />
                </div>
                <TextAreaField
                  label={t('reason')}
                  help={t('reasonHelp')}
                  value={reason}
                  minLength={3}
                  maxLength={500}
                  rows={2}
                  required
                  onChange={(event) => setReason(event.target.value)}
                />
                {error && (
                  <Alert tone="error">
                    <p>{errorMessage(error)}</p>
                  </Alert>
                )}
                {extended && (
                  <Alert tone="success">
                    <p>{t('extended')}</p>
                  </Alert>
                )}
                <div className={styles.actions}>
                  <Button type="submit" busy={busy}>
                    {t('extend')}
                  </Button>
                </div>
              </>
            ) : (
              <p className={styles.muted}>{t('noExtension')}</p>
            )}
          </form>
        </Panel>
      )}

      <Panel title={t('membersTitle', { count: detail.members.length })}>
        <p className={styles.muted}>{t('membersHelp')}</p>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('member')}</th>
                <th scope="col">{t('role')}</th>
                <th scope="col">{t('status')}</th>
              </tr>
            </thead>
            <tbody>
              {detail.members.map((member) => (
                <tr key={member.userId}>
                  <th scope="row">
                    <a
                      className={styles.link}
                      href={getPathname({ href: `/admin/users/${member.userId}`, locale })}
                    >
                      {member.displayName}
                    </a>
                  </th>
                  <td>{member.role === 'MEMBER' ? member.kind : member.role}</td>
                  <td>{member.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
