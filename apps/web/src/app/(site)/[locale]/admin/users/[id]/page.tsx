import { adminUserDetailSchema } from '@integris/shared';
import { PageHeader } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { AdminFrame } from '../../../../../../components/admin/AdminFrame';
import { UserDetailView } from '../../../../../../components/admin/UserDetailView';
import { authMetadata } from '../../../../../../components/auth/AuthChrome';
import { requireSuperAdmin } from '../../../../../../lib/admin';
import { serverGet } from '../../../../../../lib/server-api';

interface PageProps {
  params: Promise<{ locale: Locale; id: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Admin' });
  return authMetadata(t('user.title'));
}

/** Back-office: one account, its credit, refunds and pilot trial (step 14, no mockup). */
export default async function AdminUserPage({ params }: PageProps) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const me = await requireSuperAdmin(locale);
  const detail = await serverGet(`admin/users/${encodeURIComponent(id)}`, adminUserDetailSchema);
  if (!detail) notFound();
  const t = await getTranslations('Admin');
  return (
    <AdminFrame me={me} locale={locale} section="users" path={`/admin/users/${id}`}>
      <PageHeader title={detail.user.displayName} subtitle={t('user.subtitle')} />
      <UserDetailView initial={detail} />
    </AdminFrame>
  );
}
