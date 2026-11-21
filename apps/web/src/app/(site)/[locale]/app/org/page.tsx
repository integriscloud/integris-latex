import { organizationViewSchema } from '@integris/shared';
import { PageHeader } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppFrame } from '../../../../../components/app/AppFrame';
import { authMetadata } from '../../../../../components/auth/AuthChrome';
import { OrgOverview } from '../../../../../components/organization/OrgOverview';
import { redirect } from '../../../../../i18n/navigation';
import { requireOrganizationSpace } from '../../../../../lib/organization-page';
import { serverGet } from '../../../../../lib/server-api';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Organization' });
  return authMetadata(t('metaTitle'));
}

/** Home of the organization (mockup etablissement-01 for the owner and admins). */
export default async function OrganizationPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { me, space } = await requireOrganizationSpace(locale);
  const view = await serverGet(`organizations/${space.id}`, organizationViewSchema);
  if (!view) return redirect({ href: '/app', locale });
  const t = await getTranslations('Organization');
  return (
    <AppFrame me={me} locale={locale} section="organization" path="/app/org">
      <PageHeader
        title={view.name}
        subtitle={t(view.me.manages ? 'subtitleManager' : 'subtitleMember', {
          plan: t(`plans.${view.subscription.planCode}`),
        })}
      />
      <OrgOverview initial={view} />
    </AppFrame>
  );
}
