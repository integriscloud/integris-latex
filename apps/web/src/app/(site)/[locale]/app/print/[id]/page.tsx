import { printRequestPageSchema } from '@integris/shared';
import { PageHeader } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { AppFrame, type AppSection } from '../../../../../../components/app/AppFrame';
import { authMetadata } from '../../../../../../components/auth/AuthChrome';
import { PrintRequestScreen } from '../../../../../../components/exams/PrintRequestScreen';
import { redirect } from '../../../../../../i18n/navigation';
import { currentOrganization } from '../../../../../../lib/organization';
import { serverGet } from '../../../../../../lib/server-api';
import { requireMe } from '../../../../../../lib/session';

interface PageProps {
  params: Promise<{ locale: Locale; id: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Secretariat' });
  return authMetadata(t('request.metaTitle'));
}

/**
 * One print request: "Ouvrir et imprimer" for its secretariat, the preview for its teacher and
 * co-editors, the request and its journal for the organization's managers. The API decides.
 */
export default async function PrintRequestPage({ params }: PageProps) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const me = await requireMe(locale);
  if (!me.currentSpaceId) return redirect({ href: '/spaces', locale });
  const page = await serverGet(`print-requests/${encodeURIComponent(id)}`, printRequestPageSchema);
  if (!page) notFound();
  const space = currentOrganization(me);
  const section: AppSection =
    space?.memberKind === 'SECRETARY'
      ? 'printQueue'
      : space?.role === 'OWNER' || space?.role === 'ADMIN'
        ? 'printRequests'
        : 'exams';
  return (
    <AppFrame me={me} locale={locale} section={section} path={`/app/print/${id}`}>
      <PageHeader title={page.request.title} subtitle={page.request.groupName} />
      <PrintRequestScreen initial={page} />
    </AppFrame>
  );
}
