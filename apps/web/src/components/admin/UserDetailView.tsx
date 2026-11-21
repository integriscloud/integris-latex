'use client';

import {
  type AdminOrgDetail,
  type AdminUserDetail,
  BUSINESS_TRIAL_DEFAULT_SEATS,
  formatPhone,
} from '@integris/shared';
import { Alert, Badge, Button, Panel, SelectField, TextAreaField, TextField } from '@integris/ui';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { type FormEvent, type ReactNode, useState } from 'react';
import { getPathname } from '../../i18n/navigation';
import { apiPost, type ApiResult, type ClientError } from '../../lib/api-client';
import { formatBytes } from '../../lib/format';
import { useAdminAction } from './admin-actions';
import styles from './admin.module.css';
import { PaymentsTable } from './PaymentsTable';
import { useAdminErrorMessage } from './use-admin-error';

/** A back-office form: its fields, its sensitive request, its result. */
function ActionForm<T>({
  title,
  help,
  submit,
  done,
  send,
  onDone,
  children,
}: {
  title: string;
  help: string;
  submit: string;
  done: string;
  send: () => Promise<ApiResult<T>>;
  onDone: (data: T) => void;
  children: ReactNode;
}) {
  const run = useAdminAction();
  const errorMessage = useAdminErrorMessage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  const [ok, setOk] = useState(false);
  const submitForm = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setOk(false);
    const result = await run(send);
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setOk(true);
    onDone(result.data);
  };
  return (
    <Panel title={title}>
      <form className={styles.form} onSubmit={submitForm}>
        <p className={styles.muted}>{help}</p>
        {children}
        {error && (
          <Alert tone="error">
            <p>{errorMessage(error)}</p>
          </Alert>
        )}
        {ok && (
          <Alert tone="success">
            <p>{done}</p>
          </Alert>
        )}
        <div className={styles.actions}>
          <Button type="submit" busy={busy}>
            {submit}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

const digits = (value: string) => value.replace(/\D/g, '');

/** An account in the back-office: plans, usage in numbers, payments, credit, actions. */
export function UserDetailView({ initial }: { initial: AdminUserDetail }) {
  const t = useTranslations('Admin.user');
  const format = useFormatter();
  const locale = useLocale();
  const [detail, setDetail] = useState(initial);
  const [credit, setCredit] = useState({ amount: '', note: '' });
  const [refund, setRefund] = useState({ amount: '', note: '', reference: '', paymentId: '' });
  const [trial, setTrial] = useState({ name: '', seats: String(BUSINESS_TRIAL_DEFAULT_SEATS) });
  const [trialOrg, setTrialOrg] = useState<string | null>(null);
  const { user } = detail;
  const money = (amount: number) => t('money', { amount });
  const date = (value: string) => format.dateTime(new Date(value), { dateStyle: 'medium' });
  const credited = detail.payments.filter((payment) => payment.status === 'CREDITED');

  return (
    <div className={styles.stack}>
      <Panel title={t('identity')}>
        <dl className={styles.facts}>
          <dt>{t('name')}</dt>
          <dd>
            {user.displayName} {user.superAdmin && <Badge tone="info">{t('superAdmin')}</Badge>}{' '}
            {user.disabled && <Badge tone="danger">{t('disabled')}</Badge>}
          </dd>
          <dt>{t('phone')}</dt>
          <dd>{user.phone ? formatPhone(user.phone) : '—'}</dd>
          <dt>{t('email')}</dt>
          <dd>
            {user.email ?? '—'}
            {user.email && !user.emailVerified && ` (${t('unverified')})`}
          </dd>
          <dt>{t('created')}</dt>
          <dd>{date(user.createdAt)}</dd>
          <dt>{t('language')}</dt>
          <dd>{user.locale.toUpperCase()}</dd>
          <dt>{t('emailNotifications')}</dt>
          <dd>
            {user.emailNotifications.length
              ? user.emailNotifications.map((category) => t(`categories.${category}`)).join(', ')
              : t('none')}
          </dd>
        </dl>
      </Panel>

      <Panel title={t('plansTitle')}>
        {detail.plans.length ? (
          <ul className={styles.history}>
            {detail.plans.map((plan, index) => (
              <li key={index}>
                {t('plan', {
                  plan: plan.planCode,
                  status: plan.status,
                  organization: plan.organizationName ?? '',
                  kind: plan.kind,
                  end: date(plan.periodEnd),
                })}
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.muted}>{t('freeOnly')}</p>
        )}
        {detail.organizations.length > 0 && (
          <ul className={styles.history}>
            {detail.organizations.map((organization) => (
              <li key={organization.id}>
                <a
                  className={styles.link}
                  href={getPathname({ href: `/admin/organizations/${organization.id}`, locale })}
                >
                  {organization.name}
                </a>{' '}
                · {organization.type} · {organization.role}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title={t('usageTitle')}>
        <p className={styles.muted}>{t('usageHelp')}</p>
        <dl className={styles.facts}>
          <dt>{t('projects')}</dt>
          <dd>{detail.usage.projects}</dd>
          <dt>{t('storage')}</dt>
          <dd>{formatBytes(detail.usage.storageBytes, locale)}</dd>
          <dt>{t('compilations')}</dt>
          <dd>{detail.usage.compilesThisMonth}</dd>
        </dl>
      </Panel>

      <Panel title={t('creditTitle', { balance: money(detail.creditBalance) })}>
        {detail.credits.length ? (
          <ul className={styles.history}>
            {detail.credits.map((entry) => (
              <li key={entry.id}>
                {t('creditEntry', {
                  date: date(entry.createdAt),
                  amount: entry.amountXof,
                  reason: entry.reason,
                })}
                {entry.note && ` — ${entry.note}`}
                {entry.reference && ` (${entry.reference})`}
                {entry.createdBy && ` · ${entry.createdBy}`}
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.muted}>{t('noCredit')}</p>
        )}
      </Panel>

      <ActionForm
        title={t('addCredit.title')}
        help={t('addCredit.help')}
        submit={t('addCredit.submit')}
        done={t('addCredit.done')}
        send={() =>
          apiPost<AdminUserDetail>(`admin/users/${user.id}/credits`, {
            amountXof: Number(digits(credit.amount)),
            note: credit.note,
          })
        }
        onDone={(data) => {
          setDetail(data);
          setCredit({ amount: '', note: '' });
        }}
      >
        <div className={styles.fields}>
          <TextField
            label={t('amount')}
            inputMode="numeric"
            pattern="[0-9 ]*"
            value={credit.amount}
            required
            onChange={(event) => setCredit({ ...credit, amount: event.target.value })}
          />
        </div>
        <TextAreaField
          label={t('note')}
          value={credit.note}
          minLength={3}
          maxLength={500}
          rows={2}
          required
          onChange={(event) => setCredit({ ...credit, note: event.target.value })}
        />
      </ActionForm>

      <ActionForm
        title={t('refund.title')}
        help={t('refund.help', { balance: money(detail.creditBalance) })}
        submit={t('refund.submit')}
        done={t('refund.done')}
        send={() =>
          apiPost<AdminUserDetail>(`admin/users/${user.id}/refunds`, {
            amountXof: Number(digits(refund.amount)),
            note: refund.note,
            reference: refund.reference,
            ...(refund.paymentId ? { paymentId: refund.paymentId } : {}),
          })
        }
        onDone={(data) => {
          setDetail(data);
          setRefund({ amount: '', note: '', reference: '', paymentId: '' });
        }}
      >
        <div className={styles.fields}>
          <TextField
            label={t('amount')}
            inputMode="numeric"
            pattern="[0-9 ]*"
            value={refund.amount}
            required
            onChange={(event) => setRefund({ ...refund, amount: event.target.value })}
          />
          <TextField
            label={t('refund.reference')}
            help={t('refund.referenceHelp')}
            value={refund.reference}
            minLength={3}
            maxLength={120}
            required
            onChange={(event) => setRefund({ ...refund, reference: event.target.value })}
          />
          {credited.length > 0 && (
            <SelectField
              label={t('refund.payment')}
              value={refund.paymentId}
              options={[
                { value: '', label: t('refund.noPayment') },
                ...credited.map((payment) => ({
                  value: payment.id,
                  label: t('refund.paymentOption', {
                    receipt: String(payment.receiptNumber ?? 0).padStart(6, '0'),
                    amount: payment.amountXof,
                  }),
                })),
              ]}
              onChange={(event) => setRefund({ ...refund, paymentId: event.target.value })}
            />
          )}
        </div>
        <TextAreaField
          label={t('note')}
          value={refund.note}
          minLength={3}
          maxLength={500}
          rows={2}
          required
          onChange={(event) => setRefund({ ...refund, note: event.target.value })}
        />
      </ActionForm>

      {!detail.businessTrialUsed && !user.disabled && (
        <ActionForm
          title={t('trial.title')}
          help={t('trial.help')}
          submit={t('trial.submit')}
          done={t('trial.done')}
          send={() =>
            apiPost<AdminOrgDetail>('admin/business-trials', {
              ownerId: user.id,
              organizationName: trial.name.trim(),
              seats: Number(digits(trial.seats)),
            })
          }
          onDone={(organization) => {
            setTrialOrg(organization.organization.id);
            setDetail({ ...detail, businessTrialUsed: true });
          }}
        >
          <div className={styles.fields}>
            <TextField
              label={t('trial.name')}
              value={trial.name}
              minLength={2}
              maxLength={120}
              required
              onChange={(event) => setTrial({ ...trial, name: event.target.value })}
            />
            <TextField
              label={t('trial.seats')}
              inputMode="numeric"
              pattern="[0-9]*"
              value={trial.seats}
              required
              onChange={(event) => setTrial({ ...trial, seats: event.target.value })}
            />
          </div>
        </ActionForm>
      )}
      {trialOrg && (
        <Alert tone="success">
          <p>
            <a
              className={styles.link}
              href={getPathname({ href: `/admin/organizations/${trialOrg}`, locale })}
            >
              {t('trial.open')}
            </a>
          </p>
        </Alert>
      )}

      <Panel title={t('paymentsTitle')}>
        <PaymentsTable payments={detail.payments} />
      </Panel>
    </div>
  );
}
