import { printRequestListSchema } from '@integris/shared';
import { PageHeader } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppFrame } from '../../../../../../components/app/AppFrame';
import { authMetadata } from '../../../../../../components/auth/AuthChrome';
import { PrintHistoryView } from '../../../../../../components/exams/SecretariatQueueView';
import { redirect } from '../../../../../../i18n/navigation';
import { requireOrganizationSpace } from '../../../../../../lib/organization-page';
import { serverGet } from '../../../../../../lib/server-api';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Secretariat' });
  return authMetadata(t('history.metaTitle'));
}

/** "Historique" of a secretariat: requests handed over or canceled (no mockup yet). */
export default async function PrintHistoryPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { me, space } = await requireOrganizationSpace(locale, {
    business: true,
    kind: 'SECRETARY',
  });
  const data = await serverGet(`organizations/${space.id}/print-history`, printRequestListSchema);
  if (!data) return redirect({ href: '/app', locale });
  const t = await getTranslations('Secretariat');
  return (
    <AppFrame me={me} locale={locale} section="printHistory" path="/app/print/history">
      <PageHeader title={t('history.title')} subtitle={space.organizationName ?? undefined} />
      <PrintHistoryView requests={data.requests} />
    </AppFrame>
  );
}
