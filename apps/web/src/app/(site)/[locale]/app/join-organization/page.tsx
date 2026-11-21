import { myJoinRequestsSchema } from '@integris/shared';
import { PageHeader, Panel } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppFrame } from '../../../../../components/app/AppFrame';
import { authMetadata } from '../../../../../components/auth/AuthChrome';
import { JoinWithCode } from '../../../../../components/organization/JoinWithCode';
import { redirect } from '../../../../../i18n/navigation';
import { serverGet } from '../../../../../lib/server-api';
import { requireMe } from '../../../../../lib/session';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'JoinOrganization' });
  return authMetadata(t('title'));
}

/** "Rejoindre un établissement" (mockup commun-03, "Saisir un code"): a teacher's join request. */
export default async function JoinOrganizationPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMe(locale);
  if (!me.currentSpaceId) return redirect({ href: '/spaces', locale });
  const requests = await serverGet('organizations/join-requests', myJoinRequestsSchema);
  const t = await getTranslations('JoinOrganization');
  return (
    <AppFrame me={me} locale={locale} section="join" path="/app/join-organization">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <Panel>
        <JoinWithCode requests={requests ?? []} />
      </Panel>
    </AppFrame>
  );
}
