import { AuthCard, AuthHeading, AuthPageLayout } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AuthBrand, AuthLanguages, authMetadata } from '../../../components/auth/AuthChrome';
import { ForgotPasswordForm } from '../../../components/auth/ForgotPasswordForm';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Auth.forgot' });
  return authMetadata(t('metaTitle'));
}

/** Screen without mockup: asks for a reset link by e-mail. */
export default async function ForgotPasswordPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Auth.forgot');
  return (
    <AuthPageLayout
      brand={<AuthBrand locale={locale} />}
      barEnd={<AuthLanguages locale={locale} path="/forgot-password" />}
      narrow
    >
      <AuthHeading title={t('title')} subtitle={t('subtitle')} />
      <AuthCard>
        <ForgotPasswordForm locale={locale} />
      </AuthCard>
    </AuthPageLayout>
  );
}
