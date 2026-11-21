import { membersPageSchema } from '@integris/shared';
import { PageHeader } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppFrame } from '../../../../../../components/app/AppFrame';
import { authMetadata } from '../../../../../../components/auth/AuthChrome';
import { GroupsView } from '../../../../../../components/organization/GroupsView';
import { redirect } from '../../../../../../i18n/navigation';
import { requireOrganizationSpace } from '../../../../../../lib/organization-page';
import { serverGet } from '../../../../../../lib/server-api';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Groups' });
  return authMetadata(t('metaTitle'));
}

/** "Classes et filières" (screen without mockup): owner and admins of a BUSINESS. */
export default async function GroupsPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { me, space } = await requireOrganizationSpace(locale, { manager: true, business: true });
  const page = await serverGet(`organizations/${space.id}/members`, membersPageSchema);
  if (!page) return redirect({ href: '/app', locale });
  const t = await getTranslations('Groups');
  return (
    <AppFrame me={me} locale={locale} section="groups" path="/app/org/groups">
      <PageHeader title={t('pageTitle')} subtitle={t('subtitle')} />
      <GroupsView organizationId={space.id} initial={page.groups} />
    </AppFrame>
  );
}
