import { ComingSoon } from '@integris/ui';
import type { Metadata } from 'next';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPathname } from '../i18n/navigation';
import { PublicFooter } from './PublicFooter';
import { PublicHeader } from './PublicHeader';

export type ComingSoonKey = 'terms' | 'privacy';

interface ComingSoonPageProps {
  params: Promise<{ locale: Locale }>;
}

/** Build a placeholder page (screen not built yet) for one public route. */
export function comingSoonPage(key: ComingSoonKey) {
  async function generateMetadata({ params }: ComingSoonPageProps): Promise<Metadata> {
    const { locale } = await params;
    const t = await getTranslations({ locale, namespace: 'ComingSoon' });
    return { title: t(key), robots: { index: false } };
  }

  async function Page({ params }: ComingSoonPageProps) {
    const { locale } = await params;
    setRequestLocale(locale);
    const t = await getTranslations('ComingSoon');

    return (
      <>
        <PublicHeader locale={locale} path={`/${key}`} />
        <main>
          <ComingSoon
            title={t(key)}
            text={t('text')}
            back={{ href: getPathname({ href: '/', locale }), label: t('back') }}
          />
        </main>
        <PublicFooter locale={locale} />
      </>
    );
  }

  return { generateMetadata, Page };
}
