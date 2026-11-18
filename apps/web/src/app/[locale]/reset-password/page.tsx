import { AuthCard, AuthHeading, AuthPageLayout } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { ApiUnavailable, AuthBrand, authMetadata } from '../../../components/auth/AuthChrome';
import { ResetPasswordForm } from '../../../components/auth/ResetPasswordForm';
import { fetchAuthConfig } from '../../../lib/auth-config';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Auth.reset' });
  return authMetadata(t('metaTitle'));
}

/** Screen without mockup: new password from the e-mailed link (token in the URL fragment). */
export default async function ResetPasswordPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Auth.reset');
  const config = await fetchAuthConfig();
  return (
    <AuthPageLayout brand={<AuthBrand locale={locale} />} narrow>
      <AuthHeading title={t('title')} />
      <AuthCard>{config ? <ResetPasswordForm config={config} /> : <ApiUnavailable />}</AuthCard>
    </AuthPageLayout>
  );
}
