'use client';

import type { SimulatedInvoice } from '@integris/shared';
import { Alert, Button, Panel } from '@integris/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { apiPost } from '../../lib/api-client';
import styles from './billing.module.css';
import { useBillingError } from './use-billing-error';

type Outcome = 'completed' | 'notcompleted' | 'pending';

/**
 * Development only: the page the simulated LigdiCash sends the payer to. The outcome chosen here
 * is what the simulated status API answers; the API then receives the callback and checks the
 * payment exactly as with LigdiCash.
 */
export function SimulatedPayment({ invoice }: { invoice: SimulatedInvoice }) {
  const t = useTranslations('Billing');
  const errorMessage = useBillingError();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const settle = async (outcome: Outcome) => {
    setBusy(true);
    setError(null);
    const result = await apiPost(`payments/simulated/${invoice.token}`, { outcome });
    if (!result.ok) {
      setBusy(false);
      setError(errorMessage(result.error));
      return;
    }
    window.location.assign(outcome === 'notcompleted' ? invoice.cancelUrl : invoice.returnUrl);
  };

  return (
    <Panel title={t('sim.title')}>
      <div className={styles.result}>
        <Alert tone="warning" announce={false}>
          <p>{t('sim.warning')}</p>
        </Alert>
        <p className={styles.text}>{invoice.description}</p>
        <p className={styles.amount}>
          {t('sim.amount', { amount: t('amount', { amount: invoice.amountXof }) })}
        </p>
        {error && (
          <Alert tone="error">
            <p>{error}</p>
          </Alert>
        )}
        <div className={styles.actions}>
          <Button variant="accent" disabled={busy} onClick={() => void settle('completed')}>
            {t('sim.pay')}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => void settle('notcompleted')}>
            {t('sim.refuse')}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => void settle('pending')}>
            {t('sim.wait')}
          </Button>
        </div>
      </div>
    </Panel>
  );
}
