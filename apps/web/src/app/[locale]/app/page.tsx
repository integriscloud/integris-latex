import { AuthCard, AuthHeading, AuthPageLayout, ButtonLink } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import styles from '../../../components/auth/auth-forms.module.css';
import { AuthBrand, authMetadata } from '../../../components/auth/AuthChrome';
import { SignedInBar } from '../../../components/auth/SignedInBar';
import { spaceLabels } from '../../../components/auth/space-labels';
import { getPathname, redirect } from '../../../i18n/navigation';
import { requireMe } from '../../../lib/session';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'AppHome' });
  return authMetadata(t('metaTitle'));
}

/**
 * Landing page of a signed-in user (screen without mockup). The projects list replaces it at
 * step 4 of the development plan.
 */
export default async function AppHomePage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMe(locale);
  const space = me.spaces.find((item) => item.id === me.currentSpaceId);
  if (!space) return redirect({ href: '/spaces', locale });

  const t = await getTranslations('AppHome');
  const ts = await getTranslations('Spaces');
  return (
    <AuthPageLayout
      brand={<AuthBrand locale={locale} />}
      barEnd={<SignedInBar me={me} locale={locale} path="/app" />}
      narrow
    >
      <AuthHeading title={t('title', { name: me.user.displayName })} />
      <AuthCard>
        <p className={styles.text}>{t('space', { space: spaceLabels(space, ts).title })}</p>
        <p className={styles.muted}>{t('comingSoon')}</p>
        <div className={styles.submitRow}>
          {me.spaces.length > 1 && (
            <ButtonLink href={getPathname({ href: '/spaces', locale })} variant="secondary">
              {t('switchSpace')}
            </ButtonLink>
          )}
          <ButtonLink href={getPathname({ href: '/account', locale })} variant="secondary">
            {t('account')}
          </ButtonLink>
        </div>
      </AuthCard>
    </AuthPageLayout>
  );
}
