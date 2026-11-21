import { mySupervisorsSchema } from '@integris/shared';
import { PageHeader } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppFrame } from '../../../../../components/app/AppFrame';
import { authMetadata } from '../../../../../components/auth/AuthChrome';
import { MySupervisorsView } from '../../../../../components/organization/MySupervisorsView';
import { redirect } from '../../../../../i18n/navigation';
import { requireOrganizationSpace } from '../../../../../lib/organization-page';
import { serverGet } from '../../../../../lib/server-api';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'MySupervisors' });
  return authMetadata(t('metaTitle'));
}

/** "Mes encadreurs" of a student (BUSINESS, screen without mockup). */
export default async function SupervisorsPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { me, space } = await requireOrganizationSpace(locale, {
    business: true,
    kind: 'STUDENT',
  });
  const data = await serverGet(`organizations/${space.id}/my-supervisors`, mySupervisorsSchema);
  if (!data) return redirect({ href: '/app', locale });
  const t = await getTranslations('MySupervisors');
  return (
    <AppFrame me={me} locale={locale} section="supervisors" path="/app/supervisors">
      <PageHeader title={t('pageTitle')} subtitle={t('subtitle')} />
      <MySupervisorsView organizationId={space.id} initial={data} />
    </AppFrame>
  );
}
