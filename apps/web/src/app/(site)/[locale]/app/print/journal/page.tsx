import { printJournalSchema } from '@integris/shared';
import { PageHeader, Panel } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppFrame } from '../../../../../../components/app/AppFrame';
import { authMetadata } from '../../../../../../components/auth/AuthChrome';
import { PrintJournal } from '../../../../../../components/exams/print-shared';
import { redirect } from '../../../../../../i18n/navigation';
import { requireOrganizationSpace } from '../../../../../../lib/organization-page';
import { serverGet } from '../../../../../../lib/server-api';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Secretariat' });
  return authMetadata(t('journal.metaTitle'));
}

/** "Journal d'accès" of a secretariat: every access to the requests of its groups (no mockup). */
export default async function PrintJournalPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { me, space } = await requireOrganizationSpace(locale, {
    business: true,
    kind: 'SECRETARY',
  });
  const data = await serverGet(`organizations/${space.id}/print-journal`, printJournalSchema);
  if (!data) return redirect({ href: '/app', locale });
  const t = await getTranslations('Secretariat');
  return (
    <AppFrame me={me} locale={locale} section="printJournal" path="/app/print/journal">
      <PageHeader title={t('journal.title')} subtitle={t('journal.subtitle')} />
      <Panel>
        <PrintJournal events={data.events} showRequest />
      </Panel>
    </AppFrame>
  );
}
