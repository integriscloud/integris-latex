import { projectListSchema, TRASH_RETENTION_DAYS } from '@integris/shared';
import { PageHeader } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppFrame } from '../../../../../components/app/AppFrame';
import { TrashView } from '../../../../../components/app/TrashView';
import { authMetadata } from '../../../../../components/auth/AuthChrome';
import { redirect } from '../../../../../i18n/navigation';
import { serverGet } from '../../../../../lib/server-api';
import { requireMe } from '../../../../../lib/session';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Trash' });
  return authMetadata(t('metaTitle'));
}

/** Trash of the user's projects (screen without mockup). */
export default async function TrashPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMe(locale);
  if (!me.currentSpaceId) return redirect({ href: '/spaces', locale });
  const list = await serverGet('projects?view=trash', projectListSchema);
  if (!list) return redirect({ href: '/login', locale });
  const t = await getTranslations('Trash');

  return (
    <AppFrame me={me} locale={locale} section="trash" path="/app/trash">
      <PageHeader title={t('title')} subtitle={t('subtitle', { days: TRASH_RETENTION_DAYS })} />
      <TrashView list={list} />
    </AppFrame>
  );
}
