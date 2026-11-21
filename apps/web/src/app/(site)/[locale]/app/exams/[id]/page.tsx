import { examPaperDetailSchema, projectDetailSchema } from '@integris/shared';
import { PageHeader } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { AppFrame } from '../../../../../../components/app/AppFrame';
import { authMetadata } from '../../../../../../components/auth/AuthChrome';
import { ExamPaperView } from '../../../../../../components/exams/ExamPaperView';
import { redirect } from '../../../../../../i18n/navigation';
import { serverGet } from '../../../../../../lib/server-api';
import { requireMe } from '../../../../../../lib/session';

interface PageProps {
  params: Promise<{ locale: Locale; id: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Exams' });
  return authMetadata(t('metaTitlePaper'));
}

/**
 * One exam paper for its owner and co-editors: parts, sends to the secretariat, requests,
 * co-editors and journal. The API answers "not found" to anyone else.
 */
export default async function ExamPaperPage({ params }: PageProps) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const me = await requireMe(locale);
  if (!me.currentSpaceId) return redirect({ href: '/spaces', locale });
  const [detail, project] = await Promise.all([
    serverGet(`exam-papers/${encodeURIComponent(id)}`, examPaperDetailSchema),
    serverGet(`projects/${encodeURIComponent(id)}`, projectDetailSchema),
  ]);
  if (!detail || !project) notFound();
  const t = await getTranslations('Exams');
  const fileIds = Object.fromEntries(project.files.map((file) => [file.path, file.id]));
  return (
    <AppFrame me={me} locale={locale} section="exams" path={`/app/exams/${id}`}>
      <PageHeader
        title={detail.name}
        subtitle={
          detail.role === 'OWNER'
            ? t('ownerSubtitle')
            : t('coeditorSubtitle', { name: detail.ownerName })
        }
      />
      <ExamPaperView initial={detail} fileIds={fileIds} />
    </AppFrame>
  );
}
