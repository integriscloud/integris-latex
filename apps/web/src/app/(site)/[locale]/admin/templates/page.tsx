import { adminTemplateListSchema } from '@integris/shared';
import { PageHeader } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { AdminFrame } from '../../../../../components/admin/AdminFrame';
import { PublicTemplatesView } from '../../../../../components/admin/PublicTemplatesView';
import { authMetadata } from '../../../../../components/auth/AuthChrome';
import { requireSuperAdmin } from '../../../../../lib/admin';
import { serverGet } from '../../../../../lib/server-api';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Admin' });
  return authMetadata(t('templates.title'));
}

/** Back-office: public templates (step 14, screen without mockup). */
export default async function AdminTemplatesPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireSuperAdmin(locale);
  const data = await serverGet('admin/templates', adminTemplateListSchema);
  if (!data) notFound();
  const t = await getTranslations('Admin');
  return (
    <AdminFrame me={me} locale={locale} section="templates" path="/admin/templates">
      <PageHeader title={t('templates.title')} subtitle={t('templates.subtitle')} />
      <PublicTemplatesView initial={data} />
    </AdminFrame>
  );
}
