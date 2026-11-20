import {
  BILLING_PERIODS,
  billingOverviewSchema,
  type BillingPeriodValue,
  PAID_PLAN_CODES,
  type PaidPlanCode,
} from '@integris/shared';
import { Notice, PageHeader } from '@integris/ui';
import { ArrowLeft } from 'lucide-react';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppFrame } from '../../../../../../components/app/AppFrame';
import styles from '../../../../../../components/app/app.module.css';
import { authMetadata } from '../../../../../../components/auth/AuthChrome';
import { type CheckoutMode, CheckoutForm } from '../../../../../../components/billing/CheckoutForm';
import { getPathname, redirect } from '../../../../../../i18n/navigation';
import { fetchPublicPlans } from '../../../../../../lib/plans';
import { serverGet } from '../../../../../../lib/server-api';
import { requireMe } from '../../../../../../lib/session';

interface PageProps {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Billing' });
  return authMetadata(t('checkoutMetaTitle'));
}

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/**
 * Plan choice and payment (screen without mockup). `?plan=&period=` preselects a new plan;
 * `?renew=`, `?upgrade=` or `?seats=` with a subscription id changes one the user pays for.
 */
export default async function CheckoutPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  const query = await searchParams;
  setRequestLocale(locale);
  const me = await requireMe(locale);
  if (!me.currentSpaceId) return redirect({ href: '/spaces', locale });
  const [overview, plans] = await Promise.all([
    serverGet('billing', billingOverviewSchema),
    fetchPublicPlans(),
  ]);
  if (!overview) return redirect({ href: '/login', locale });
  const t = await getTranslations('Billing');
  const th = await getTranslations('Home');

  let mode: CheckoutMode | null = null;
  for (const kind of ['RENEW', 'UPGRADE', 'SEATS'] as const) {
    const id = one(query[kind.toLowerCase()]);
    const subscription = id && overview.subscriptions.find((row) => row.id === id);
    if (subscription) mode = { kind, subscription };
  }
  if (!mode) {
    const plan = one(query.plan)?.toUpperCase() ?? '';
    const period = one(query.period)?.toUpperCase() ?? '';
    mode = {
      kind: 'NEW',
      plan: (PAID_PLAN_CODES as readonly string[]).includes(plan)
        ? (plan as PaidPlanCode)
        : undefined,
      period: (BILLING_PERIODS as readonly string[]).includes(period)
        ? (period as BillingPeriodValue)
        : undefined,
    };
  }

  return (
    <AppFrame me={me} locale={locale} section="billing" path="/app/billing/checkout">
      <PageHeader
        title={t('checkoutTitle')}
        subtitle={t('checkoutSubtitle')}
        back={
          <a className={styles.back} href={getPathname({ href: '/app/billing', locale })}>
            <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
            {t('back')}
          </a>
        }
      />
      {plans ? (
        <CheckoutForm
          mode={mode}
          plans={plans}
          emailVerified={overview.emailVerified}
          trial={overview.trial}
        />
      ) : (
        <Notice>{th('pricing.unavailable')}</Notice>
      )}
    </AppFrame>
  );
}
