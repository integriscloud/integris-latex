'use client';

import type { BillingNotice } from '@integris/shared';
import { Alert, Button } from '@integris/ui';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { useRouter } from '../../i18n/navigation';
import { apiPost } from '../../lib/api-client';
import styles from './billing.module.css';

/** Plan code → name shown in the notices (the names of the `Plan` table are in the overview). */
export type PlanNames = Partial<Record<string, string>>;

/**
 * Unread billing notices (credited duplicate, renewal, grace, trial): the "Abonnement" banner,
 * until the notification centre of step 14. Hiding one marks it read.
 */
export function BillingNotices({
  notices,
  planNames,
  supportEmail,
}: {
  notices: BillingNotice[];
  planNames: PlanNames;
  supportEmail: string | null;
}) {
  const t = useTranslations('Billing');
  const format = useFormatter();
  const router = useRouter();
  const [hidden, setHidden] = useState<string[]>([]);
  const shown = notices.filter((notice) => !hidden.includes(notice.id));
  if (!shown.length) return null;

  const dismiss = async (id: string) => {
    setHidden((ids) => [...ids, id]);
    await apiPost('billing/notices/read', { ids: [id] });
    router.refresh();
  };

  return (
    <ul className={styles.notices} aria-label={t('noticesLabel')}>
      {shown.map((notice) => {
        const date = notice.date
          ? format.dateTime(new Date(notice.date), { dateStyle: 'long' })
          : '';
        const plan = (notice.planCode && planNames[notice.planCode]) ?? notice.planCode ?? '';
        const tone =
          notice.type === 'GRACE_STARTED' || notice.type === 'TRIAL_ENDED' ? 'warning' : 'info';
        return (
          <li key={notice.id}>
            <Alert tone={tone} announce={false}>
              <p>
                {t(`notices.${notice.type}`, {
                  plan,
                  date,
                  amount: t('amount', { amount: notice.amountXof ?? 0 }),
                  number: String(notice.receiptNumber ?? 0).padStart(6, '0'),
                })}
                {notice.type === 'PAYMENT_CREDITED' && (
                  <> {supportEmail ? t('refund', { email: supportEmail }) : t('refundReply')}</>
                )}
              </p>
              <Button variant="ghost" onClick={() => void dismiss(notice.id)}>
                {t('dismiss')}
              </Button>
            </Alert>
          </li>
        );
      })}
    </ul>
  );
}
