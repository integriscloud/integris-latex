import { supervisionDashboardSchema } from '@integris/shared';
import { PageHeader } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppFrame } from '../../../../../components/app/AppFrame';
import { authMetadata } from '../../../../../components/auth/AuthChrome';
import { SupervisionDashboardView } from '../../../../../components/organization/SupervisionDashboardView';
import { redirect } from '../../../../../i18n/navigation';
import { requireOrganizationSpace } from '../../../../../lib/organization-page';
import { serverGet } from '../../../../../lib/server-api';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'SupervisionDashboard' });
  return authMetadata(t('metaTitle'));
}

/** "Mes étudiants": supervision dashboard of a teacher (BUSINESS). */
export default async function StudentsPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { me, space } = await requireOrganizationSpace(locale, {
    business: true,
    kind: 'TEACHER',
  });
  const data = await serverGet(
    `organizations/${space.id}/supervision-dashboard`,
    supervisionDashboardSchema,
  );
  if (!data) return redirect({ href: '/app', locale });
  const t = await getTranslations('SupervisionDashboard');
  return (
    <AppFrame me={me} locale={locale} section="students" path="/app/students">
      <PageHeader title={t('title')} subtitle={space.organizationName ?? undefined} />
      <SupervisionDashboardView data={data} />
    </AppFrame>
  );
}
