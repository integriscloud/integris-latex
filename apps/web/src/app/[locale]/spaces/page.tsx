import { AuthHeading, AuthPageLayout } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AuthBrand, authMetadata } from '../../../components/auth/AuthChrome';
import { SignedInBar } from '../../../components/auth/SignedInBar';
import { SpaceChooser } from '../../../components/auth/SpaceChooser';
import { redirect } from '../../../i18n/navigation';
import { requireMe } from '../../../lib/session';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Spaces' });
  return authMetadata(t('metaTitle'));
}

/** "Choisir son espace", skipped when the user has a single space. */
export default async function SpacesPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMe(locale);
  if (me.spaces.length === 1) redirect({ href: '/app', locale });

  const t = await getTranslations('Spaces');
  return (
    <AuthPageLayout
      brand={<AuthBrand locale={locale} />}
      barEnd={<SignedInBar me={me} locale={locale} path="/spaces" />}
      narrow
    >
      <AuthHeading title={t('title', { name: me.user.displayName })} subtitle={t('subtitle')} />
      <SpaceChooser me={me} />
    </AuthPageLayout>
  );
}
