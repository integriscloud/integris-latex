import { adminOrgDetailSchema } from '@integris/shared';
import { PageHeader } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { AdminFrame } from '../../../../../../components/admin/AdminFrame';
import { OrganizationDetailView } from '../../../../../../components/admin/OrganizationDetailView';
import { authMetadata } from '../../../../../../components/auth/AuthChrome';
import { requireSuperAdmin } from '../../../../../../lib/admin';
import { serverGet } from '../../../../../../lib/server-api';

interface PageProps {
  params: Promise<{ locale: Locale; id: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Admin' });
  return authMetadata(t('organization.title'));
}

/** Back-office: one organization and its pilot trial (step 14, screen without mockup). */
export default async function AdminOrganizationPage({ params }: PageProps) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const me = await requireSuperAdmin(locale);
  const detail = await serverGet(
    `admin/organizations/${encodeURIComponent(id)}`,
    adminOrgDetailSchema,
  );
  if (!detail) notFound();
  const t = await getTranslations('Admin');
  return (
    <AdminFrame me={me} locale={locale} section="organizations" path={`/admin/organizations/${id}`}>
      <PageHeader title={detail.organization.name} subtitle={t('organization.subtitle')} />
      <OrganizationDetailView initial={detail} />
    </AdminFrame>
  );
}
