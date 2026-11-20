import { billingOverviewSchema } from '@integris/shared';
import { PageHeader } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppFrame } from '../../../../../components/app/AppFrame';
import { authMetadata } from '../../../../../components/auth/AuthChrome';
import { BillingView } from '../../../../../components/billing/BillingView';
import { redirect } from '../../../../../i18n/navigation';
import { planNamesOf } from '../../../../../lib/billing';
import { fetchPublicPlans } from '../../../../../lib/plans';
import { serverGet } from '../../../../../lib/server-api';
import { requireMe } from '../../../../../lib/session';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Billing' });
  return authMetadata(t('metaTitle'));
}

/** "Abonnement": plans paid, credit, trial, payments and receipts (screen without mockup). */
export default async function BillingPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMe(locale);
  if (!me.currentSpaceId) return redirect({ href: '/spaces', locale });
  const [overview, plans] = await Promise.all([
    serverGet('billing', billingOverviewSchema),
    fetchPublicPlans(),
  ]);
  if (!overview) return redirect({ href: '/login', locale });
  const t = await getTranslations('Billing');

  return (
    <AppFrame me={me} locale={locale} section="billing" path="/app/billing">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <BillingView overview={overview} planNames={planNamesOf(plans, locale)} />
    </AppFrame>
  );
}
