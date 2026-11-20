import { submissionDetailSchema } from '@integris/shared';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { AppFrame } from '../../../../../../../../../components/app/AppFrame';
import { authMetadata } from '../../../../../../../../../components/auth/AuthChrome';
import { SubmissionCompare } from '../../../../../../../../../components/submissions/SubmissionCompare';
import { redirect } from '../../../../../../../../../i18n/navigation';
import { serverGet } from '../../../../../../../../../lib/server-api';
import { requireMe } from '../../../../../../../../../lib/session';

interface PageProps {
  params: Promise<{ locale: Locale; id: string; sid: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Submissions' });
  return authMetadata(t('compareMetaTitle'));
}

const numberOf = (value: string | undefined) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

/** Line-by-line comparison of two versions of a submission. */
export default async function SubmissionComparePage({ params, searchParams }: PageProps) {
  const { locale, id, sid } = await params;
  const query = await searchParams;
  setRequestLocale(locale);
  const me = await requireMe(locale);
  if (!me.currentSpaceId) return redirect({ href: '/spaces', locale });
  const detail = await serverGet(
    `projects/${encodeURIComponent(id)}/submissions/${encodeURIComponent(sid)}`,
    submissionDetailSchema,
  );
  if (!detail) notFound();
  const last = detail.lastNumber ?? 1;
  const to = numberOf(query.to) ?? last;
  const from = numberOf(query.from) ?? Math.max(1, to - 1);

  return (
    <AppFrame
      me={me}
      locale={locale}
      section="projects"
      path={`/app/projects/${id}/submissions/${sid}/compare`}
    >
      <SubmissionCompare detail={detail} from={from} to={to} />
    </AppFrame>
  );
}
