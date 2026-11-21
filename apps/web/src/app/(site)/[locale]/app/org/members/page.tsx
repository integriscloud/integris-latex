import { membersPageSchema, organizationViewSchema } from '@integris/shared';
import { PageHeader } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppFrame } from '../../../../../../components/app/AppFrame';
import { authMetadata } from '../../../../../../components/auth/AuthChrome';
import { MembersView } from '../../../../../../components/organization/MembersView';
import { redirect } from '../../../../../../i18n/navigation';
import { requireOrganizationSpace } from '../../../../../../lib/organization-page';
import { serverGet } from '../../../../../../lib/server-api';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Members' });
  return authMetadata(t('metaTitle'));
}

/** "Utilisateurs" (mockup etablissement-02): owner and admins only. */
export default async function MembersPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { me, space } = await requireOrganizationSpace(locale, { manager: true });
  const [view, page] = await Promise.all([
    serverGet(`organizations/${space.id}`, organizationViewSchema),
    serverGet(`organizations/${space.id}/members`, membersPageSchema),
  ]);
  if (!view || !page) return redirect({ href: '/app', locale });
  const t = await getTranslations('Members');
  return (
    <AppFrame me={me} locale={locale} section="members" path="/app/org/members">
      <PageHeader title={t('title')} subtitle={view.name} />
      <MembersView organization={view} initial={page} meId={me.user.id} />
    </AppFrame>
  );
}
