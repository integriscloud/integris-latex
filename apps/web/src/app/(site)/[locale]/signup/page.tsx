import { AuthPageLayout } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import {
  ApiUnavailable,
  AuthBrand,
  AuthLanguages,
  authMetadata,
} from '../../../../components/auth/AuthChrome';
import { SignupForm } from '../../../../components/auth/SignupForm';
import { Link, redirect } from '../../../../i18n/navigation';
import { fetchAuthConfig } from '../../../../lib/auth-config';
import { getMe, homePath } from '../../../../lib/session';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Auth.signup' });
  return authMetadata(t('metaTitle'));
}

export default async function SignupPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await getMe();
  if (me) redirect({ href: homePath(me), locale });

  const t = await getTranslations('Auth.signup');
  const config = await fetchAuthConfig();
  const brand = <AuthBrand locale={locale} />;
  const barEnd = (
    <>
      <AuthLanguages locale={locale} path="/signup" />
      <span>
        {t('alreadyRegistered')} <Link href="/login">{t('login')}</Link>
      </span>
    </>
  );

  if (!config) {
    return (
      <AuthPageLayout brand={brand} barEnd={barEnd} narrow>
        <ApiUnavailable />
      </AuthPageLayout>
    );
  }
  return <SignupForm config={config} locale={locale} brand={brand} barEnd={barEnd} />;
}
