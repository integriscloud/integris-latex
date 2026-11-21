import { notificationsPageSchema } from '@integris/shared';
import { PageHeader } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppFrame } from '../../../../../components/app/AppFrame';
import { authMetadata } from '../../../../../components/auth/AuthChrome';
import { NotificationCenter } from '../../../../../components/notifications/NotificationCenter';
import { redirect } from '../../../../../i18n/navigation';
import { serverGet } from '../../../../../lib/server-api';
import { requireMe } from '../../../../../lib/session';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Notifications' });
  return authMetadata(t('metaTitle'));
}

/** Notification centre (step 14, screen without mockup). */
export default async function NotificationsPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMe(locale);
  if (!me.currentSpaceId) return redirect({ href: '/spaces', locale });
  const page = await serverGet('notifications', notificationsPageSchema);
  if (!page) return redirect({ href: '/login', locale });
  const t = await getTranslations('Notifications');

  return (
    <AppFrame me={me} locale={locale} section="notifications" path="/app/notifications">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <NotificationCenter initial={page} />
    </AppFrame>
  );
}
