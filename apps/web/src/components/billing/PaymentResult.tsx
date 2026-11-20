'use client';

import type { PaymentStatusView } from '@integris/shared';
import { Alert, ButtonLink } from '@integris/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { getPathname } from '../../i18n/navigation';
import { apiRead } from '../../lib/api-client';
import styles from './billing.module.css';
import type { PlanNames } from './BillingNotices';

const POLL_MS = 3000;
/** After this, the page stops asking (the scheduler and the callback still settle it). */
const POLL_LIMIT = 60;

/**
 * Back from LigdiCash (screen without mockup): the API checks the payment with LigdiCash and the
 * page asks again every few seconds while it is pending. The return address itself proves
 * nothing; only the status read from LigdiCash by the API counts.
 */
export function PaymentResult({
  initial,
  canceled,
  planNames,
}: {
  initial: PaymentStatusView;
  canceled: boolean;
  planNames: PlanNames;
}) {
  const t = useTranslations('Billing');
  const locale = useLocale();
  const [payment, setPayment] = useState(initial);
  const [polls, setPolls] = useState(0);
  const pending = payment.status === 'PENDING';

  useEffect(() => {
    if (!pending || polls >= POLL_LIMIT) return;
    const timer = setTimeout(async () => {
      const result = await apiRead<PaymentStatusView>(`billing/payments/${payment.id}`);
      if (result.ok) setPayment(result.data);
      setPolls((count) => count + 1);
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [pending, polls, payment.id]);

  const amount = (value: number) => t('amount', { amount: value });
  const plan = planNames[payment.planCode] ?? payment.planCode;
  const billing = getPathname({ href: '/app/billing', locale });
  const number = String(payment.receiptNumber ?? 0).padStart(6, '0');

  return (
    <div className={styles.result} aria-live="polite">
      {pending && (
        <>
          <Alert tone="info" announce={false}>
            <p>{polls >= 10 ? t('result.pendingLong') : t('result.pending')}</p>
          </Alert>
          {canceled && <p className={styles.text}>{t('result.canceled')}</p>}
          {payment.checkoutUrl && (
            <div className={styles.actions}>
              <ButtonLink href={payment.checkoutUrl} variant="secondary">
                {t('result.resume')}
              </ButtonLink>
            </div>
          )}
        </>
      )}
      {payment.status === 'SUCCEEDED' && (
        <Alert tone="success" announce={false}>
          <p>
            {t('result.succeeded', { plan })}
            {payment.receiptNumber !== null && <> {t('result.receiptSent', { number })}</>}
          </p>
        </Alert>
      )}
      {payment.status === 'SUCCEEDED' && payment.creditedXof > 0 && (
        <p className={styles.text}>{t('credited', { amount: amount(payment.creditedXof) })}</p>
      )}
      {payment.status === 'CREDITED' && (
        <Alert tone="warning" announce={false}>
          <p>
            {t('result.credited', { amount: amount(payment.creditedXof) })}{' '}
            {payment.supportEmail ? t('refund', { email: payment.supportEmail }) : t('refundReply')}
          </p>
        </Alert>
      )}
      {payment.status === 'FAILED' && (
        <Alert tone="error" announce={false}>
          <p>{t('result.failed')}</p>
        </Alert>
      )}
      <div className={styles.actions}>
        {payment.status === 'FAILED' && (
          <ButtonLink
            href={getPathname({ href: '/app/billing/checkout', locale })}
            variant="accent"
          >
            {t('result.retry')}
          </ButtonLink>
        )}
        <ButtonLink href={billing} variant="secondary">
          {t('back')}
        </ButtonLink>
      </div>
    </div>
  );
}
