import { supervisionAdminSchema } from '@integris/shared';
import { PageHeader } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppFrame } from '../../../../../../components/app/AppFrame';
import { authMetadata } from '../../../../../../components/auth/AuthChrome';
import { SupervisionAdminView } from '../../../../../../components/organization/SupervisionAdminView';
import { redirect } from '../../../../../../i18n/navigation';
import { requireOrganizationSpace } from '../../../../../../lib/organization-page';
import { serverGet } from '../../../../../../lib/server-api';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'SupervisionAdmin' });
  return authMetadata(t('metaTitle'));
}

/** Assignments of supervisors (screen without mockup): owner and admins of a BUSINESS. */
export default async function SupervisionAdminPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { me, space } = await requireOrganizationSpace(locale, { manager: true, business: true });
  const data = await serverGet(`organizations/${space.id}/supervisions`, supervisionAdminSchema);
  if (!data) return redirect({ href: '/app', locale });
  const t = await getTranslations('SupervisionAdmin');
  return (
    <AppFrame me={me} locale={locale} section="supervision" path="/app/org/supervision">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <SupervisionAdminView organizationId={space.id} initial={data} />
    </AppFrame>
  );
}
