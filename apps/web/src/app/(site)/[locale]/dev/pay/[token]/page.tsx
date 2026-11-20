import { simulatedInvoiceSchema } from '@integris/shared';
import { Container, Notice } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { authMetadata } from '../../../../../../components/auth/AuthChrome';
import { SimulatedPayment } from '../../../../../../components/billing/SimulatedPayment';
import { serverGet } from '../../../../../../lib/server-api';
import { requireMe } from '../../../../../../lib/session';

interface PageProps {
  params: Promise<{ locale: Locale; token: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Billing' });
  return authMetadata(t('sim.metaTitle'));
}

/**
 * Development only: the simulated LigdiCash page (PAYMENT_PROVIDER=simulated). The API answers
 * 404 in production or with the real LigdiCash, so this page does too.
 */
export default async function SimulatedPaymentPage({ params }: PageProps) {
  const { locale, token } = await params;
  setRequestLocale(locale);
  if (process.env.NODE_ENV === 'production' || !/^sim_[A-Za-z0-9_-]{10,40}$/.test(token)) {
    notFound();
  }
  await requireMe(locale);
  const invoice = await serverGet(`payments/simulated/${token}`, simulatedInvoiceSchema);
  const t = await getTranslations('Billing');
  return (
    <Container>
      {invoice ? <SimulatedPayment invoice={invoice} /> : <Notice>{t('sim.gone')}</Notice>}
    </Container>
  );
}
