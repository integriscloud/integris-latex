import { examPaperListSchema } from '@integris/shared';
import { PageHeader } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppFrame } from '../../../../../components/app/AppFrame';
import { authMetadata } from '../../../../../components/auth/AuthChrome';
import { ExamPapersView } from '../../../../../components/exams/ExamPapersView';
import { redirect } from '../../../../../i18n/navigation';
import { requireOrganizationSpace } from '../../../../../lib/organization-page';
import { serverGet } from '../../../../../lib/server-api';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Exams' });
  return authMetadata(t('metaTitle'));
}

/** "Mes devoirs": exam papers of a teacher of a BUSINESS (step 13). */
export default async function ExamsPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { me, space } = await requireOrganizationSpace(locale, {
    business: true,
    kind: 'TEACHER',
  });
  const data = await serverGet('exam-papers', examPaperListSchema);
  if (!data) return redirect({ href: '/app', locale });
  const t = await getTranslations('Exams');
  return (
    <AppFrame me={me} locale={locale} section="exams" path="/app/exams">
      <PageHeader title={t('title')} subtitle={space.organizationName ?? undefined} />
      <ExamPapersView data={data} />
    </AppFrame>
  );
}
