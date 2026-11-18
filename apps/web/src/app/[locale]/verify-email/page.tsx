import { AuthCard, AuthHeading, AuthPageLayout } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AuthBrand, authMetadata } from '../../../components/auth/AuthChrome';
import { VerifyEmail } from '../../../components/auth/VerifyEmail';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Auth.verifyEmail' });
  return authMetadata(t('metaTitle'));
}

/** Screen without mockup: confirms the e-mail address from the link (token in the fragment). */
export default async function VerifyEmailPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Auth.verifyEmail');
  return (
    <AuthPageLayout brand={<AuthBrand locale={locale} />} narrow>
      <AuthHeading title={t('title')} />
      <AuthCard>
        <VerifyEmail />
      </AuthCard>
    </AuthPageLayout>
  );
}
