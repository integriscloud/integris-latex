import { projectDetailSchema, projectLimitsSchema } from '@integris/shared';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { AppFrame } from '../../../../../../components/app/AppFrame';
import { ProjectFiles } from '../../../../../../components/app/ProjectFiles';
import { authMetadata } from '../../../../../../components/auth/AuthChrome';
import { redirect } from '../../../../../../i18n/navigation';
import { serverGet } from '../../../../../../lib/server-api';
import { requireMe } from '../../../../../../lib/session';

interface PageProps {
  params: Promise<{ locale: Locale; id: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'ProjectPage' });
  return authMetadata(t('metaTitle'));
}

/** A project and its files. The API answers "not found" to anyone without a role on it. */
export default async function ProjectPage({ params }: PageProps) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const me = await requireMe(locale);
  if (!me.currentSpaceId) return redirect({ href: '/spaces', locale });
  const [project, limits] = await Promise.all([
    serverGet(`projects/${encodeURIComponent(id)}`, projectDetailSchema),
    serverGet('projects/limits', projectLimitsSchema),
  ]);
  if (!project || !limits) notFound();

  return (
    <AppFrame me={me} locale={locale} section="projects" path={`/app/projects/${id}`}>
      <ProjectFiles initial={project} limits={limits} />
    </AppFrame>
  );
}
