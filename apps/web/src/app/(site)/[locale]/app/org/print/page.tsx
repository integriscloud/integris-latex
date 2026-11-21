import { orgPrintOverviewSchema } from '@integris/shared';
import { PageHeader } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppFrame } from '../../../../../../components/app/AppFrame';
import { authMetadata } from '../../../../../../components/auth/AuthChrome';
import { OrgPrintView } from '../../../../../../components/exams/OrgPrintView';
import { redirect } from '../../../../../../i18n/navigation';
import { requireOrganizationSpace } from '../../../../../../lib/organization-page';
import { serverGet } from '../../../../../../lib/server-api';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'OrgPrint' });
  return authMetadata(t('metaTitle'));
}

/** Print requests and access journal of a BUSINESS, for its owner and admins (step 13). */
export default async function OrgPrintPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { me, space } = await requireOrganizationSpace(locale, { manager: true, business: true });
  const data = await serverGet(`organizations/${space.id}/print-requests`, orgPrintOverviewSchema);
  if (!data) return redirect({ href: '/app', locale });
  const t = await getTranslations('OrgPrint');
  return (
    <AppFrame me={me} locale={locale} section="printRequests" path="/app/org/print">
      <PageHeader title={t('title')} subtitle={space.organizationName ?? undefined} />
      <OrgPrintView data={data} />
    </AppFrame>
  );
}
