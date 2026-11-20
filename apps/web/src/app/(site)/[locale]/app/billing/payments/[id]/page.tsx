import { paymentStatusSchema } from '@integris/shared';
import { PageHeader } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { AppFrame } from '../../../../../../../components/app/AppFrame';
import { authMetadata } from '../../../../../../../components/auth/AuthChrome';
import { PaymentResult } from '../../../../../../../components/billing/PaymentResult';
import { redirect } from '../../../../../../../i18n/navigation';
import { planNamesOf } from '../../../../../../../lib/billing';
import { fetchPublicPlans } from '../../../../../../../lib/plans';
import { serverGet } from '../../../../../../../lib/server-api';
import { requireMe } from '../../../../../../../lib/session';

interface PageProps {
  params: Promise<{ locale: Locale; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Billing' });
  return authMetadata(t('paymentMetaTitle'));
}

/** Return page of LigdiCash (return and cancel addresses): the payment as the API checked it. */
export default async function PaymentPage({ params, searchParams }: PageProps) {
  const { locale, id } = await params;
  const query = await searchParams;
  setRequestLocale(locale);
  const me = await requireMe(locale);
  if (!me.currentSpaceId) return redirect({ href: '/spaces', locale });
  if (!/^[a-z0-9]{1,64}$/.test(id)) notFound();
  const [payment, plans] = await Promise.all([
    serverGet(`billing/payments/${id}`, paymentStatusSchema),
    fetchPublicPlans(),
  ]);
  if (!payment) notFound();
  const t = await getTranslations('Billing');

  return (
    <AppFrame me={me} locale={locale} section="billing" path={`/app/billing/payments/${id}`}>
      <PageHeader title={t('paymentMetaTitle')} />
      <PaymentResult
        initial={payment}
        canceled={query.canceled === '1'}
        planNames={planNamesOf(plans, locale)}
      />
    </AppFrame>
  );
}
