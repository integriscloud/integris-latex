import type { AdminPaymentRow } from '@integris/shared';
import { useFormatter, useTranslations } from 'next-intl';
import styles from './admin.module.css';

/** Payments of the back-office (amounts in FCFA, TTC), newest first. */
export function PaymentsTable({
  payments,
  userHref,
}: {
  payments: AdminPaymentRow[];
  /** Link to the payer's page; none on the payer's own page. */
  userHref?: (userId: string) => string;
}) {
  const t = useTranslations('Admin.payments');
  const format = useFormatter();
  if (!payments.length) return <p className={styles.muted}>{t('none')}</p>;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{t('date')}</th>
            {userHref && <th scope="col">{t('payer')}</th>}
            <th scope="col">{t('what')}</th>
            <th scope="col" className={styles.number}>
              {t('amount')}
            </th>
            <th scope="col">{t('status')}</th>
            <th scope="col">{t('receipt')}</th>
            <th scope="col">{t('transaction')}</th>
          </tr>
        </thead>
        <tbody>
          {payments.map((payment) => (
            <tr key={payment.id}>
              <td>
                {format.dateTime(new Date(payment.createdAt), {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </td>
              {userHref && (
                <td>
                  <a className={styles.link} href={userHref(payment.userId)}>
                    {payment.userName}
                  </a>
                </td>
              )}
              <td>
                {t('order', {
                  purpose: payment.purpose,
                  plan: payment.planCode,
                  seats: payment.seats,
                })}
              </td>
              <td className={styles.number}>
                {t('money', { amount: payment.amountXof })}
                {payment.creditUsedXof > 0 && (
                  <>
                    <br />
                    {t('creditUsed', { amount: payment.creditUsedXof })}
                  </>
                )}
              </td>
              <td>
                {t(`statuses.${payment.status as 'PENDING'}`)}
                {payment.duplicateReason && (
                  <>
                    <br />
                    <span className={styles.muted}>{payment.duplicateReason}</span>
                  </>
                )}
              </td>
              <td>
                {payment.receiptNumber ? String(payment.receiptNumber).padStart(6, '0') : '—'}
              </td>
              <td>{payment.providerTransactionId ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
