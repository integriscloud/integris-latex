import { adminStatsSchema } from '@integris/shared';
import { PageHeader } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { AdminFrame } from '../../../../components/admin/AdminFrame';
import { StatsView } from '../../../../components/admin/StatsView';
import { authMetadata } from '../../../../components/auth/AuthChrome';
import { requireSuperAdmin } from '../../../../lib/admin';
import { serverGet } from '../../../../lib/server-api';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Admin' });
  return authMetadata(t('metaTitle'));
}

/** Back-office dashboard: statistics (step 14, screen without mockup). */
export default async function AdminPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireSuperAdmin(locale);
  const stats = await serverGet('admin/stats', adminStatsSchema);
  if (!stats) notFound();
  const t = await getTranslations('Admin');
  return (
    <AdminFrame me={me} locale={locale} section="dashboard" path="/admin">
      <PageHeader title={t('stats.title')} subtitle={t('stats.subtitle')} />
      <StatsView stats={stats} />
    </AdminFrame>
  );
}
