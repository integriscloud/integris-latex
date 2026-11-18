import { AuthHeading, AuthSplitLayout } from '@integris/ui';
import { GraduationCap, FileText, Users } from 'lucide-react';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import {
  ApiUnavailable,
  AuthBrand,
  AuthLanguages,
  authMetadata,
} from '../../../../components/auth/AuthChrome';
import { LoginForm } from '../../../../components/auth/LoginForm';
import { redirect } from '../../../../i18n/navigation';
import { fetchAuthConfig } from '../../../../lib/auth-config';
import { getMe, homePath } from '../../../../lib/session';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Auth.login' });
  return authMetadata(t('metaTitle'));
}

export default async function LoginPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await getMe();
  if (me) redirect({ href: homePath(me), locale });

  const t = await getTranslations('Auth');
  const config = await fetchAuthConfig();

  return (
    <AuthSplitLayout
      brand={<AuthBrand locale={locale} inverted />}
      compactBrand={<AuthBrand locale={locale} />}
      title={t('brandAside.title')}
      text={t('brandAside.text')}
      features={[
        {
          icon: GraduationCap,
          title: t('brandAside.institutions.title'),
          text: t('brandAside.institutions.text'),
        },
        { icon: Users, title: t('brandAside.teachers.title'), text: t('brandAside.teachers.text') },
        {
          icon: FileText,
          title: t('brandAside.students.title'),
          text: t('brandAside.students.text'),
        },
      ]}
      tools={<AuthLanguages locale={locale} path="/login" />}
    >
      <AuthHeading title={t('login.title')} subtitle={t('login.subtitle')} />
      {config ? <LoginForm config={config} locale={locale} /> : <ApiUnavailable />}
    </AuthSplitLayout>
  );
}
