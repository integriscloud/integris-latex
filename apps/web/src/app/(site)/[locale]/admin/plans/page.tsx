import { adminPlansSchema } from '@integris/shared';
import { PageHeader } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { AdminFrame } from '../../../../../components/admin/AdminFrame';
import { PlansView } from '../../../../../components/admin/PlansView';
import { authMetadata } from '../../../../../components/auth/AuthChrome';
import { requireSuperAdmin } from '../../../../../lib/admin';
import { serverGet } from '../../../../../lib/server-api';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Admin' });
  return authMetadata(t('plans.title'));
}

/** Back-office: plans, prices and quotas (step 14, screen without mockup). */
export default async function AdminPlansPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireSuperAdmin(locale);
  const data = await serverGet('admin/plans', adminPlansSchema);
  if (!data) notFound();
  const t = await getTranslations('Admin');
  return (
    <AdminFrame me={me} locale={locale} section="plans" path="/admin/plans">
      <PageHeader title={t('plans.title')} subtitle={t('plans.subtitle')} />
      <PlansView initial={data} />
    </AdminFrame>
  );
}
