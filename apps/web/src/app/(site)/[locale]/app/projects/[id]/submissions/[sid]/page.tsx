import { submissionDetailSchema } from '@integris/shared';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { AppFrame } from '../../../../../../../../components/app/AppFrame';
import { authMetadata } from '../../../../../../../../components/auth/AuthChrome';
import { SubmissionView } from '../../../../../../../../components/submissions/SubmissionView';
import { redirect } from '../../../../../../../../i18n/navigation';
import { serverGet } from '../../../../../../../../lib/server-api';
import { requireMe } from '../../../../../../../../lib/session';

interface PageProps {
  params: Promise<{ locale: Locale; id: string; sid: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Submissions' });
  return authMetadata(t('metaTitle'));
}

/** Review page of a submission. The API answers "not found" to anyone without a role. */
export default async function SubmissionPage({ params }: PageProps) {
  const { locale, id, sid } = await params;
  setRequestLocale(locale);
  const me = await requireMe(locale);
  if (!me.currentSpaceId) return redirect({ href: '/spaces', locale });
  const detail = await serverGet(
    `projects/${encodeURIComponent(id)}/submissions/${encodeURIComponent(sid)}`,
    submissionDetailSchema,
  );
  if (!detail) notFound();

  return (
    <AppFrame
      me={me}
      locale={locale}
      section="projects"
      path={`/app/projects/${id}/submissions/${sid}`}
    >
      <SubmissionView initial={detail} />
    </AppFrame>
  );
}
