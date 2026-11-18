import { projectDetailSchema } from '@integris/shared';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { authMetadata } from '../../../../../../../components/auth/AuthChrome';
import { EditorLoader } from '../../../../../../../components/editor/EditorLoader';
import { redirect } from '../../../../../../../i18n/navigation';
import { serverGet } from '../../../../../../../lib/server-api';
import { requireMe } from '../../../../../../../lib/session';

interface PageProps {
  params: Promise<{ locale: Locale; id: string }>;
  searchParams: Promise<{ file?: string | string[] }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Editor' });
  return authMetadata(t('metaTitle'));
}

/**
 * Editor of a project, `?file=<id>` for the file to open (the main file by default). The API
 * answers "not found" to anyone without a role on the project and checks the rights again on
 * every read and save.
 */
export default async function EditorPage({ params, searchParams }: PageProps) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const me = await requireMe(locale);
  if (!me.currentSpaceId) return redirect({ href: '/spaces', locale });
  const project = await serverGet(`projects/${encodeURIComponent(id)}`, projectDetailSchema);
  if (!project) notFound();
  const { file } = await searchParams;

  return <EditorLoader initial={project} initialFileId={typeof file === 'string' ? file : null} />;
}
