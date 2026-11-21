'use client';

import { type AdminPromo, PAID_PLAN_CODES, type PaidPlanCode } from '@integris/shared';
import { Alert, Badge, Button, Checkbox, Panel, TextField } from '@integris/ui';
import { CircleCheck } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { apiPost, apiRequest, type ClientError } from '../../lib/api-client';
import { useAdminAction } from './admin-actions';
import styles from './admin.module.css';
import { useAdminErrorMessage } from './use-admin-error';

/** End of the chosen day (UTC) from a `yyyy-mm-dd` field. */
const endOfDay = (day: string) => (day ? new Date(`${day}T23:59:59Z`).toISOString() : null);

/** Promo codes: percentage, plans, end date and number of uses (docs/spec.md, step 14). */
export function PromoCodesView({ initial }: { initial: AdminPromo[] }) {
  const t = useTranslations('Admin.promos');
  const format = useFormatter();
  const run = useAdminAction();
  const errorMessage = useAdminErrorMessage();
  const [promos, setPromos] = useState(initial);
  const [code, setCode] = useState('');
  const [percent, setPercent] = useState('');
  const [plans, setPlans] = useState<PaidPlanCode[]>([]);
  const [until, setUntil] = useState('');
  const [max, setMax] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const [created, setCreated] = useState(false);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('create');
    setError(null);
    setCreated(false);
    const result = await run(() =>
      apiPost<AdminPromo[]>('admin/promo-codes', {
        code,
        percentOff: Number(percent),
        planCodes: plans,
        validUntil: endOfDay(until),
        maxRedemptions: max ? Number(max) : null,
      }),
    );
    setBusy(null);
    if (!result.ok) return setError(result.error);
    setPromos(result.data);
    setCode('');
    setPercent('');
    setPlans([]);
    setUntil('');
    setMax('');
    setCreated(true);
  };

  const toggle = async (promo: AdminPromo) => {
    setBusy(promo.id);
    setError(null);
    const result = await run(() =>
      apiRequest<AdminPromo[]>('PATCH', `admin/promo-codes/${promo.id}`, {
        isActive: !promo.isActive,
      }),
    );
    setBusy(null);
    if (!result.ok) return setError(result.error);
    setPromos(result.data);
  };

  return (
    <div className={styles.stack}>
      <Panel title={t('createTitle')}>
        <form className={styles.form} onSubmit={create}>
          <div className={styles.fields}>
            <TextField
              label={t('code')}
              help={t('codeHelp')}
              value={code}
              pattern="[A-Za-z0-9\-]{3,32}"
              maxLength={32}
              required
              onChange={(event) => setCode(event.target.value.toUpperCase())}
            />
            <TextField
              label={t('percent')}
              inputMode="numeric"
              pattern="[0-9]*"
              value={percent}
              required
              onChange={(event) => setPercent(event.target.value.trim())}
            />
            <TextField
              label={t('until')}
              help={t('optionalHelp')}
              type="date"
              value={until}
              onChange={(event) => setUntil(event.target.value)}
            />
            <TextField
              label={t('max')}
              help={t('optionalHelp')}
              inputMode="numeric"
              pattern="[0-9]*"
              value={max}
              onChange={(event) => setMax(event.target.value.trim())}
            />
          </div>
          <fieldset className={styles.checks}>
            <legend className={styles.legend}>{t('plans')}</legend>
            {PAID_PLAN_CODES.map((plan) => (
              <Checkbox
                key={plan}
                checked={plans.includes(plan)}
                onChange={(event) =>
                  setPlans((list) =>
                    event.target.checked ? [...list, plan] : list.filter((item) => item !== plan),
                  )
                }
              >
                {plan}
              </Checkbox>
            ))}
          </fieldset>
          <p className={styles.muted}>{t('plansHelp')}</p>
          {error && (
            <Alert tone="error">
              <p>{errorMessage(error)}</p>
            </Alert>
          )}
          {created && (
            <Alert tone="success">
              <p>{t('created')}</p>
            </Alert>
          )}
          <div className={styles.actions}>
            <Button type="submit" busy={busy === 'create'}>
              {t('create')}
            </Button>
          </div>
        </form>
      </Panel>
      <Panel title={t('listTitle', { count: promos.length })}>
        {promos.length ? (
          <ul className={styles.list}>
            {promos.map((promo) => (
              <li key={promo.id} className={styles.card}>
                <div className={styles.cardBody}>
                  <div className={styles.badges}>
                    <p className={styles.name}>{promo.code}</p>
                    {promo.isActive ? (
                      <Badge tone="success" icon={CircleCheck}>
                        {t('active')}
                      </Badge>
                    ) : (
                      <Badge tone="neutral">{t('inactive')}</Badge>
                    )}
                  </div>
                  <p className={styles.muted}>
                    {t('summary', {
                      percent: promo.percentOff,
                      plans: promo.planCodes.length ? promo.planCodes.join(', ') : t('allPlans'),
                      used: promo.redemptionCount,
                      max: promo.maxRedemptions ?? -1,
                    })}
                    {promo.validUntil &&
                      t('untilDate', {
                        date: format.dateTime(new Date(promo.validUntil), { dateStyle: 'medium' }),
                      })}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  busy={busy === promo.id}
                  onClick={() => void toggle(promo)}
                >
                  {promo.isActive ? t('deactivate') : t('activate')}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.muted}>{t('none')}</p>
        )}
      </Panel>
    </div>
  );
}
