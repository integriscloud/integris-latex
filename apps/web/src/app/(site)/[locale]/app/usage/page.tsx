import { accountUsageSchema } from '@integris/shared';
import { PageHeader } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppFrame } from '../../../../../components/app/AppFrame';
import { UsageView } from '../../../../../components/app/UsageView';
import { authMetadata } from '../../../../../components/auth/AuthChrome';
import { redirect } from '../../../../../i18n/navigation';
import { serverGet } from '../../../../../lib/server-api';
import { requireMe } from '../../../../../lib/session';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Usage' });
  return authMetadata(t('metaTitle'));
}

/** "Ma consommation": quotas of the user's plans and their usage (screen without mockup). */
export default async function UsagePage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMe(locale);
  if (!me.currentSpaceId) return redirect({ href: '/spaces', locale });
  const usage = await serverGet('usage', accountUsageSchema);
  if (!usage) return redirect({ href: '/login', locale });
  const t = await getTranslations('Usage');

  return (
    <AppFrame me={me} locale={locale} section="usage" path="/app/usage">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <UsageView usage={usage} />
    </AppFrame>
  );
}
