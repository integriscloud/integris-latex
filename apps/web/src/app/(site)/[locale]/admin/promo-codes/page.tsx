import { adminPromoListSchema } from '@integris/shared';
import { PageHeader } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { AdminFrame } from '../../../../../components/admin/AdminFrame';
import { PromoCodesView } from '../../../../../components/admin/PromoCodesView';
import { authMetadata } from '../../../../../components/auth/AuthChrome';
import { requireSuperAdmin } from '../../../../../lib/admin';
import { serverGet } from '../../../../../lib/server-api';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Admin' });
  return authMetadata(t('promos.title'));
}

/** Back-office: promo codes (step 14, screen without mockup). */
export default async function AdminPromoCodesPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireSuperAdmin(locale);
  const data = await serverGet('admin/promo-codes', adminPromoListSchema);
  if (!data) notFound();
  const t = await getTranslations('Admin');
  return (
    <AdminFrame me={me} locale={locale} section="promoCodes" path="/admin/promo-codes">
      <PageHeader title={t('promos.title')} subtitle={t('promos.subtitle')} />
      <PromoCodesView initial={data} />
    </AdminFrame>
  );
}
