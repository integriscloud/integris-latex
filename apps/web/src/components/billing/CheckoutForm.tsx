'use client';

import {
  type BilledSubscription,
  type BillingOrder,
  type BillingPeriodValue,
  type BillingOverview,
  type BillingQuote,
  type CheckoutResponse,
  isOrganizationPlan,
  type PaidPlanCode,
  planRank,
  type PublicPlan,
} from '@integris/shared';
import { Alert, Button, ChoiceCards, Panel, TextField } from '@integris/ui';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { getPathname, useRouter } from '../../i18n/navigation';
import { apiPost, type ClientError } from '../../lib/api-client';
import styles from './billing.module.css';
import { useBillingError } from './use-billing-error';

export type CheckoutMode =
  | { kind: 'NEW'; plan?: PaidPlanCode; period?: BillingPeriodValue }
  | { kind: 'RENEW' | 'UPGRADE' | 'SEATS'; subscription: BilledSubscription };

const PERIODS: BillingPeriodValue[] = ['YEARLY', 'MONTHLY'];

type PaidPlan = PublicPlan & { code: PaidPlanCode };

/** Plans the user can choose in this mode. */
function choosable(mode: CheckoutMode, plans: PublicPlan[]): PaidPlan[] {
  const paid = plans.filter((plan): plan is PaidPlan => plan.code !== 'FREE');
  if (mode.kind === 'NEW') return paid;
  if (mode.kind === 'SEATS') return paid.filter((plan) => plan.code === mode.subscription.planCode);
  const current = mode.subscription;
  const organization = current.organization !== null;
  return paid.filter((plan) => {
    if (isOrganizationPlan(plan.code) !== organization) return false;
    const rank = planRank(plan.code) - planRank(current.planCode);
    if (mode.kind === 'RENEW') return rank <= 0;
    return rank > 0 || (rank === 0 && current.period === 'MONTHLY');
  });
}

/**
 * Plan choice and payment (screen without mockup): plan, duration (yearly first), seats and the
 * organization of a TEAM or BUSINESS (Business self-serve form), promo code. The price is the
 * quote of the API, computed from the `Plan` table; paying opens the LigdiCash page.
 */
export function CheckoutForm({
  mode,
  plans,
  emailVerified,
  trial,
}: {
  mode: CheckoutMode;
  plans: PublicPlan[];
  emailVerified: boolean;
  /** The STANDARD trial: offered here instead of paying, or already in progress. */
  trial: BillingOverview['trial'];
}) {
  const t = useTranslations('Billing');
  const tp = useTranslations('Plans');
  const locale = useLocale();
  const format = useFormatter();
  const router = useRouter();
  const errorMessage = useBillingError();
  const options = choosable(mode, plans);
  const current = mode.kind === 'NEW' ? null : mode.subscription;

  const [planCode, setPlanCode] = useState<PaidPlanCode | undefined>(() =>
    mode.kind === 'NEW'
      ? (mode.plan ?? options[0]?.code)
      : mode.kind === 'UPGRADE'
        ? (options.find((plan) => plan.code !== mode.subscription.planCode)?.code ??
          options[0]?.code)
        : mode.subscription.planCode,
  );
  const plan = options.find((item) => item.code === planCode);
  const [period, setPeriod] = useState<BillingPeriodValue>(() =>
    mode.kind === 'NEW'
      ? (mode.period ?? 'YEARLY')
      : mode.kind === 'UPGRADE'
        ? 'YEARLY'
        : mode.subscription.period,
  );
  const [seatsInput, setSeatsInput] = useState(() =>
    String(mode.kind === 'SEATS' ? 1 : Math.max(current?.seats ?? 1, plan?.minSeats ?? 1)),
  );
  const [organization, setOrganization] = useState('');
  const [ifu, setIfu] = useState('');
  const [promoInput, setPromoInput] = useState('');
  const [promo, setPromo] = useState<string | undefined>(undefined);
  // A code typed but never applied is pointed out at payment, never dropped silently.
  const [promoWarning, setPromoWarning] = useState(false);
  const [quote, setQuote] = useState<BillingQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [trialError, setTrialError] = useState<string | null>(null);

  const seats = Math.max(1, Math.floor(Number(seatsInput)) || 1);
  const organizationPlan = plan ? isOrganizationPlan(plan.code) : false;
  const order = ((): BillingOrder | null => {
    if (mode.kind === 'SEATS') {
      return { kind: 'SEATS', subscriptionId: mode.subscription.id, seats };
    }
    if (!planCode) return null;
    const effectiveSeats = organizationPlan ? seats : 1;
    if (mode.kind === 'NEW') {
      return {
        kind: 'NEW',
        plan: planCode,
        period,
        seats: effectiveSeats,
        organization: organizationPlan
          ? { name: organization.trim(), ifu: ifu.trim() || undefined }
          : undefined,
        promoCode: promo,
      };
    }
    return mode.kind === 'UPGRADE'
      ? {
          kind: 'UPGRADE',
          subscriptionId: mode.subscription.id,
          plan: planCode,
          period,
          seats: effectiveSeats,
          promoCode: promo,
        }
      : {
          kind: 'RENEW',
          subscriptionId: mode.subscription.id,
          plan: planCode,
          period,
          seats: effectiveSeats,
        };
  })();
  // The organization name is only checked at payment; the quote needs a valid one meanwhile.
  const quoteOrder =
    order?.kind === 'NEW' && order.organization && order.organization.name.length < 2
      ? { ...order, organization: { name: '..' } }
      : order;
  const quoteKey = quoteOrder ? JSON.stringify(quoteOrder) : null;

  useEffect(() => {
    if (!quoteKey) return;
    let stale = false;
    const timer = setTimeout(async () => {
      const body = { order: JSON.parse(quoteKey) as BillingOrder, locale };
      const result = await apiPost<BillingQuote>('billing/quote', body);
      if (stale) return;
      if (result.ok) {
        setQuote(result.data);
        setQuoteError(null);
      } else {
        setQuote(null);
        setQuoteError(errorMessage(result.error));
        // An unusable promo code is dropped so the price without it is shown.
        if (result.error.code.startsWith('promo_')) setPromo(undefined);
      }
    }, 300);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [quoteKey, locale, errorMessage]);

  const amount = (value: number) => t('amount', { amount: value });
  const date = (value: string) => format.dateTime(new Date(value), { dateStyle: 'long' });
  const unit = (item: PublicPlan, value: BillingPeriodValue) =>
    isOrganizationPlan(item.code)
      ? tp(value === 'YEARLY' ? 'unit.seatYearly' : 'unit.seatMonthly')
      : tp(value === 'YEARLY' ? 'unit.yearly' : 'unit.monthly');
  const name = (item: PublicPlan) => (locale === 'fr' ? item.nameFr : item.nameEn);
  const saving = plan ? plan.priceMonthlyXof * 12 - plan.priceYearlyXof : 0;

  const startTrial = async () => {
    setPaying(true);
    setTrialError(null);
    const result = await apiPost('billing/trial');
    if (!result.ok) {
      setPaying(false);
      setTrialError(errorMessage(result.error));
      return;
    }
    router.push('/app/billing');
  };

  const standardNew = mode.kind === 'NEW' && planCode === 'STANDARD';
  const promoAllowed = mode.kind === 'NEW' || mode.kind === 'UPGRADE';
  const typedPromo = promoInput.trim().toUpperCase();
  const promoUnapplied = promoAllowed && typedPromo !== '' && typedPromo !== promo;

  const pay = async (withoutTypedPromo = false) => {
    if (!order) return;
    if (promoUnapplied && !withoutTypedPromo) {
      setPromoWarning(true);
      return;
    }
    setPaying(true);
    setPayError(null);
    const result = await apiPost<CheckoutResponse>('billing/checkout', { order, locale });
    if (!result.ok) {
      setPaying(false);
      setPayError(errorMessage(result.error as ClientError));
      return;
    }
    if (result.data.redirectUrl) {
      // LigdiCash refuses to be shown in a frame: the same tab goes there.
      window.location.assign(result.data.redirectUrl);
      return;
    }
    router.push(`/app/billing/payments/${result.data.paymentId}`);
  };

  const periodChoice = mode.kind !== 'SEATS' && plan && (
    <ChoiceCards
      label={t('form.period')}
      value={period}
      onChange={setPeriod}
      options={PERIODS.filter(
        (value) =>
          !(
            mode.kind === 'UPGRADE' &&
            plan.code === mode.subscription.planCode &&
            value === 'MONTHLY'
          ),
      ).map((value) => ({
        value,
        title: `${t(`period.${value}`)} · ${tp('amount', {
          amount: value === 'YEARLY' ? plan.priceYearlyXof : plan.priceMonthlyXof,
        })} ${unit(plan, value)}`,
        description:
          value === 'YEARLY' && saving > 0
            ? t(organizationPlan ? 'form.yearlySaving' : 'form.yearlySavingSingle', {
                amount: amount(saving),
              })
            : t(value === 'YEARLY' ? 'form.yearlyHelp' : 'form.monthlyHelp'),
      }))}
    />
  );

  return (
    <div className={styles.layout}>
      <div className={styles.form}>
        {!emailVerified && (
          <Alert tone="warning">
            <p>
              {t('emailRequired')}{' '}
              <a href={getPathname({ href: '/account', locale })}>{t('emailLink')}</a>
            </p>
          </Alert>
        )}
        {mode.kind !== 'SEATS' && options.length > 1 && (
          <ChoiceCards
            label={t('form.plan')}
            value={planCode ?? options[0]!.code}
            onChange={(code) => {
              setPlanCode(code);
              const next = options.find((item) => item.code === code);
              if (next) {
                setSeatsInput(String(Math.max(current?.seats ?? 1, next.minSeats)));
              }
            }}
            options={options.map((item) => ({
              value: item.code,
              title: name(item),
              description: tp(`summary.${item.code}`),
            }))}
          />
        )}
        {periodChoice}
        {mode.kind === 'SEATS' ? (
          <TextField
            label={t('form.addSeats')}
            type="number"
            inputMode="numeric"
            min={1}
            value={seatsInput}
            onChange={(event) => setSeatsInput(event.target.value)}
            help={t('form.addSeatsHelp', { date: date(mode.subscription.currentPeriodEnd) })}
          />
        ) : (
          organizationPlan &&
          plan && (
            <TextField
              label={t('form.seats')}
              type="number"
              inputMode="numeric"
              min={plan.minSeats}
              max={plan.maxSeats ?? undefined}
              value={seatsInput}
              onChange={(event) => setSeatsInput(event.target.value)}
              help={
                plan.maxSeats === null
                  ? t('form.seatsHelpMin', { min: plan.minSeats })
                  : t('form.seatsHelpRange', { min: plan.minSeats, max: plan.maxSeats })
              }
            />
          )
        )}
        {mode.kind === 'NEW' && organizationPlan && (
          <>
            <TextField
              label={t('form.organization')}
              value={organization}
              maxLength={120}
              autoComplete="organization"
              onChange={(event) => setOrganization(event.target.value)}
            />
            <TextField
              label={t('form.ifu')}
              optionalLabel={t('form.optional')}
              value={ifu}
              maxLength={40}
              onChange={(event) => setIfu(event.target.value)}
            />
          </>
        )}
        {standardNew && trial.state === 'trialing' && trial.endsAt && (
          <Alert tone="info" announce={false}>
            <p>{t('trialPaidAfter', { date: date(trial.endsAt) })}</p>
          </Alert>
        )}
        {standardNew && trial.state === 'available' && trial.days && (
          <Panel title={t('trialOfferTitle')}>
            <div className={styles.form}>
              <p className={styles.text}>{t('trialOfferText', { days: trial.days })}</p>
              <p className={styles.text}>{t('trialRule')}</p>
              {trialError && (
                <Alert tone="error">
                  <p>{trialError}</p>
                </Alert>
              )}
              <div className={styles.actions}>
                <Button variant="secondary" disabled={paying} onClick={() => void startTrial()}>
                  {t('trialStart')}
                </Button>
              </div>
            </div>
          </Panel>
        )}
        {promoAllowed && (
          <div className={styles.promo}>
            <TextField
              label={t('form.promo')}
              optionalLabel={t('form.optional')}
              value={promoInput}
              maxLength={40}
              autoCapitalize="characters"
              help={t('form.promoHelp')}
              onChange={(event) => {
                setPromoInput(event.target.value);
                setPromoWarning(false);
              }}
            />
            <Button
              variant="secondary"
              disabled={!typedPromo}
              onClick={() => {
                setPromo(typedPromo);
                setPromoWarning(false);
              }}
            >
              {t('form.applyPromo')}
            </Button>
          </div>
        )}
      </div>

      <Panel title={t('quote.title')}>
        <div className={styles.form}>
          {quoteError && (
            <Alert tone="error">
              <p>{quoteError}</p>
            </Alert>
          )}
          {!quote && !quoteError && <p className={styles.text}>{t('quote.loading')}</p>}
          {quote && (
            <>
              <dl className={styles.lines}>
                <div className={styles.line}>
                  <dt>
                    {mode.kind === 'SEATS'
                      ? t('quote.seatsBase', { seats: quote.seats, date: date(quote.periodEnd) })
                      : t('quote.base', {
                          plan: plan ? name(plan) : quote.planCode,
                          period: t(`period.${quote.period}`),
                          seats: quote.seats,
                        })}
                  </dt>
                  <dd>{amount(quote.base)}</dd>
                </div>
                {quote.promo > 0 && (
                  <div className={styles.line}>
                    <dt>{t('quote.promo', { percent: quote.promoPercent ?? 0 })}</dt>
                    <dd>−{amount(quote.promo)}</dd>
                  </div>
                )}
                {quote.prorationCredit > 0 && (
                  <div className={styles.line}>
                    <dt>{t('quote.proration')}</dt>
                    <dd>−{amount(Math.min(quote.prorationCredit, quote.base - quote.promo))}</dd>
                  </div>
                )}
                {quote.creditUsed > 0 && (
                  <div className={styles.line}>
                    <dt>{t('quote.credit')}</dt>
                    <dd>−{amount(quote.creditUsed)}</dd>
                  </div>
                )}
                <div className={`${styles.line} ${styles.total}`}>
                  <dt>{t('quote.total')}</dt>
                  <dd>{amount(quote.total)}</dd>
                </div>
              </dl>
              {mode.kind !== 'SEATS' && (
                <p className={styles.text}>
                  {t('quote.period', {
                    start: date(quote.periodStart),
                    end: date(quote.periodEnd),
                  })}
                </p>
              )}
              {mode.kind === 'UPGRADE' && <p className={styles.text}>{t('form.upgradeNow')}</p>}
              {quote.minimumTopUp > 0 && (
                <Alert tone="info" announce={false}>
                  <p>
                    {t('quote.minimum', {
                      minimum: amount(quote.minAmount),
                      total: amount(quote.total),
                      topUp: amount(quote.minimumTopUp),
                    })}
                  </p>
                </Alert>
              )}
              {quote.prorationSurplus > 0 && (
                <p className={styles.text}>
                  {t('quote.surplus', { amount: amount(quote.prorationSurplus) })}
                </p>
              )}
              {quote.creditBalance > 0 && (
                <p className={styles.text}>
                  {t('quote.balance', { amount: amount(quote.creditBalance) })}
                </p>
              )}
              {quote.total === 0 ? (
                <p className={styles.text}>{t('quote.free')}</p>
              ) : (
                <p className={styles.text}>{t('redirectNote')}</p>
              )}
              {payError && (
                <Alert tone="error">
                  <p>{payError}</p>
                </Alert>
              )}
              {promoWarning && promoUnapplied && (
                <Alert tone="warning">
                  <p>{t('form.promoUnapplied', { code: typedPromo })}</p>
                  <div className={styles.actions}>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setPromo(typedPromo);
                        setPromoWarning(false);
                      }}
                    >
                      {t('form.applyPromo')}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setPromoInput(promo ?? '');
                        setPromoWarning(false);
                        void pay(true);
                      }}
                    >
                      {t('form.promoSkip')}
                    </Button>
                  </div>
                </Alert>
              )}
              <Button
                variant="accent"
                size="large"
                disabled={paying || !emailVerified || quote.emailRequired}
                onClick={() => void pay()}
              >
                {paying
                  ? t('paying')
                  : quote.total === 0
                    ? t('confirmFree')
                    : t('pay', { amount: amount(quote.total) })}
              </Button>
            </>
          )}
        </div>
      </Panel>
    </div>
  );
}
