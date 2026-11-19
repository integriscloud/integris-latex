import { Container } from '@integris/ui';
import type { Metadata } from 'next';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { PublicFooter } from '../../../../../components/PublicFooter';
import { PublicHeader } from '../../../../../components/PublicHeader';
import { PublicProjectView } from '../../../../../components/sharing/PublicProjectView';

interface PageProps {
  params: Promise<{ locale: Locale; token: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'PublicLink' });
  return { title: t('metaTitle'), robots: { index: false, follow: false } };
}

/**
 * Screen without mockup: public read-only link of a project. The browser reads it from the API
 * (the opening is written to the audit log with the visitor's address).
 */
export default async function PublicLinkPage({ params }: PageProps) {
  const { locale, token } = await params;
  setRequestLocale(locale);
  return (
    <>
      <PublicHeader locale={locale} path={`/p/${token}`} />
      <main>
        <Container>
          <PublicProjectView token={token} />
        </Container>
      </main>
      <PublicFooter locale={locale} />
    </>
  );
}
