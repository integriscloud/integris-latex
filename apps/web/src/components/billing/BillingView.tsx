'use client';

import type { BilledSubscription, BillingOverview, PaymentSummary } from '@integris/shared';
import { Alert, Badge, type BadgeTone, Button, ButtonLink, Panel } from '@integris/ui';
import { CircleCheck } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { getPathname, useRouter } from '../../i18n/navigation';
import { apiPost, type ClientError } from '../../lib/api-client';
import styles from './billing.module.css';
import { BillingNotices, type PlanNames } from './BillingNotices';
import { useBillingError } from './use-billing-error';

const STATUS_TONE: Record<BilledSubscription['status'], BadgeTone> = {
  TRIALING: 'info',
  ACTIVE: 'success',
  GRACE: 'warning',
  PAUSED: 'neutral',
  EXPIRED: 'danger',
  CANCELED: 'neutral',
};

const PAYMENT_TONE: Record<PaymentSummary['status'], BadgeTone> = {
  PENDING: 'info',
  SUCCEEDED: 'success',
  FAILED: 'danger',
  REFUNDED: 'neutral',
  CREDITED: 'accent',
};

/**
 * "Abonnement" (screen without mockup): the plans the user pays for and their due dates, the
 * credit balance, the free trial, and the payments with their receipts (sent by e-mail only).
 */
export function BillingView({
  overview,
  planNames,
}: {
  overview: BillingOverview;
  planNames: PlanNames;
}) {
  const t = useTranslations('Billing');
  const format = useFormatter();
  const locale = useLocale();
  const router = useRouter();
  const errorMessage = useBillingError();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const date = (value: string) => format.dateTime(new Date(value), { dateStyle: 'long' });
  const amount = (value: number) => t('amount', { amount: value });
  const checkout = (query = '') =>
    `${getPathname({ href: '/app/billing/checkout', locale })}${query}`;
  const plan = (code: string) => planNames[code] ?? code;
  const hasPersonal = overview.subscriptions.some(
    (row) => !row.organization && ['TRIALING', 'ACTIVE', 'GRACE', 'PAUSED'].includes(row.status),
  );

  const run = async (
    key: string,
    call: () => Promise<{ ok: boolean; error?: ClientError }>,
    done: string,
  ) => {
    setBusy(key);
    setMessage(null);
    const result = await call();
    setBusy(null);
    if (result.ok) {
      setMessage({ tone: 'success', text: done });
      router.refresh();
    } else {
      setMessage({ tone: 'error', text: errorMessage(result.error!) });
    }
  };

  const subscriptionText = (row: BilledSubscription) => {
    switch (row.status) {
      case 'TRIALING':
        return t('trialEnd', { date: date(row.currentPeriodEnd) });
      case 'GRACE':
        return t('graceEnd', { date: date(row.graceEndsAt ?? row.currentPeriodEnd) });
      case 'PAUSED':
        return t('paused', { days: row.pausedRemainingDays ?? 0 });
      case 'EXPIRED':
      case 'CANCELED':
        return t('expired', { date: date(row.currentPeriodEnd) });
      default:
        return t('periodEnd', { date: date(row.currentPeriodEnd) });
    }
  };

  return (
    <div className={styles.form}>
      <BillingNotices
        notices={overview.notices}
        planNames={planNames}
        supportEmail={overview.supportEmail}
      />
      {message && (
        <Alert tone={message.tone}>
          <p>{message.text}</p>
        </Alert>
      )}
      {!overview.emailVerified && (
        <Alert tone="warning">
          <p>
            {t('emailRequired')}{' '}
            <a href={getPathname({ href: '/account', locale })}>{t('emailLink')}</a>
          </p>
        </Alert>
      )}

      {overview.subscriptions.length > 0 ? (
        <div className={styles.subscriptions}>
          {overview.subscriptions.map((row) => (
            <article key={row.id} className={styles.card}>
              <div className={styles.cardHead}>
                <h2 className={styles.planName}>
                  {locale === 'fr' ? row.planName.fr : row.planName.en}
                </h2>
                <Badge tone={STATUS_TONE[row.status]}>{t(`status.${row.status}`)}</Badge>
              </div>
              <p className={styles.text}>
                {row.organization
                  ? t('organization', { name: row.organization.name })
                  : t('personal')}
                {' · '}
                {t(`period.${row.period}`)}
              </p>
              {row.organization && (
                <p className={styles.text}>
                  {t('seats', { used: row.seatsUsed, total: row.seats })}
                </p>
              )}
              <p className={styles.text}>{subscriptionText(row)}</p>
              {row.pending && (
                <p className={styles.text}>
                  {t('pending', {
                    plan: plan(row.pending.planCode),
                    period: t(`period.${row.pending.period}`),
                    seats: row.pending.seats,
                  })}
                </p>
              )}
              <div className={styles.actions}>
                {['ACTIVE', 'GRACE', 'EXPIRED'].includes(row.status) && !row.pending && (
                  <ButtonLink href={checkout(`?renew=${row.id}`)} variant="primary">
                    {t('renew')}
                  </ButtonLink>
                )}
                {['ACTIVE', 'GRACE'].includes(row.status) &&
                  !row.pending &&
                  (row.organization
                    ? row.planCode === 'TEAM' || row.period === 'MONTHLY'
                    : row.period === 'MONTHLY') && (
                    <ButtonLink href={checkout(`?upgrade=${row.id}`)} variant="secondary">
                      {t('upgrade')}
                    </ButtonLink>
                  )}
                {row.organization && row.status === 'ACTIVE' && (
                  <ButtonLink href={checkout(`?seats=${row.id}`)} variant="secondary">
                    {t('addSeats')}
                  </ButtonLink>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className={styles.text}>{t('noSubscription')}</p>
      )}

      <div className={styles.actions}>
        <ButtonLink href={checkout()} variant={hasPersonal ? 'secondary' : 'accent'}>
          {t('choosePlan')}
        </ButtonLink>
      </div>

      {overview.trial.days && overview.trial.state !== 'subscribed' && (
        <Panel title={t('trialTitle')}>
          <div className={styles.form}>
            {overview.trial.state === 'available' ? (
              <>
                <p className={styles.text}>{t('trialText', { days: overview.trial.days })}</p>
                <p className={styles.text}>{t('trialRule')}</p>
                <div className={styles.actions}>
                  <Button
                    variant="secondary"
                    disabled={busy !== null}
                    onClick={() =>
                      void run('trial', () => apiPost('billing/trial'), t('trialStarted'))
                    }
                  >
                    {t('trialStart')}
                  </Button>
                </div>
              </>
            ) : (
              <p className={styles.text}>
                {t(`trialState.${overview.trial.state}`, {
                  date: overview.trial.endsAt ? date(overview.trial.endsAt) : '',
                })}
              </p>
            )}
          </div>
        </Panel>
      )}

      {overview.creditBalance > 0 && (
        <Panel title={t('creditTitle')}>
          <div className={styles.form}>
            <p className={styles.text}>
              {t('creditText', { amount: amount(overview.creditBalance) })}
            </p>
            <p className={styles.text}>
              {overview.supportEmail
                ? t('refund', { email: overview.supportEmail })
                : t('refundReply')}
            </p>
          </div>
        </Panel>
      )}

      <Panel title={t('paymentsTitle')}>
        {overview.payments.length === 0 ? (
          <p className={styles.text}>{t('noPayments')}</p>
        ) : (
          <>
            <p className={styles.text}>{t('receiptByEmail')}</p>
            <ul className={styles.payments}>
              {overview.payments.map((payment) => (
                <li key={payment.id} className={styles.payment}>
                  <div className={styles.paymentText}>
                    <span>
                      {t(`purpose.${payment.purpose}`, { plan: plan(payment.planCode) })}
                      {payment.organizationName ? ` · ${payment.organizationName}` : ''}
                    </span>
                    <span className={styles.text}>
                      {date(payment.createdAt)}
                      {payment.receiptNumber !== null &&
                        ` · ${t('receipt', { number: String(payment.receiptNumber).padStart(6, '0') })}`}
                      {payment.creditedXof > 0 &&
                        ` · ${t('credited', { amount: amount(payment.creditedXof) })}`}
                    </span>
                  </div>
                  <div className={styles.actions}>
                    <span className={styles.amount}>{amount(payment.amountXof)}</span>
                    <Badge
                      tone={PAYMENT_TONE[payment.status]}
                      icon={payment.status === 'SUCCEEDED' ? CircleCheck : undefined}
                    >
                      {t(`paymentStatus.${payment.status}`)}
                    </Badge>
                    {payment.receiptNumber !== null && overview.emailVerified && (
                      <Button
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() =>
                          void run(
                            payment.id,
                            () => apiPost(`billing/payments/${payment.id}/receipt`),
                            t('resent'),
                          )
                        }
                      >
                        {t('resend')}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>
    </div>
  );
}
