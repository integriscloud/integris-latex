import { AuthCard, AuthHeading, AuthPageLayout } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AuthBrand, authMetadata } from '../../../../components/auth/AuthChrome';
import { OrgInvitation } from '../../../../components/organization/OrgInvitation';
import { getMe } from '../../../../lib/session';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'OrgInvitation' });
  return authMetadata(t('metaTitle'));
}

/** Screen without mockup: invitation to an organization (token in the fragment of the link). */
export default async function OrgInvitationPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('OrgInvitation');
  const me = await getMe();
  return (
    <AuthPageLayout brand={<AuthBrand locale={locale} />} narrow>
      <AuthHeading title={t('title')} />
      <AuthCard>
        <OrgInvitation signedInAs={me?.user.displayName ?? null} />
      </AuthCard>
    </AuthPageLayout>
  );
}
