import { Container, LanguageSwitcher } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPathname } from '../../i18n/navigation';
import { routing } from '../../i18n/routing';
import styles from './page.module.css';

interface HomePageProps {
  params: Promise<{ locale: Locale }>;
}

export default async function HomePage({ params }: HomePageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Home');
  const common = await getTranslations('Common');

  const languages = routing.locales.map((code) => ({
    locale: code,
    label: code.toUpperCase(),
    name: common(`languages.${code}`),
    href: getPathname({ href: '/', locale: code }),
  }));

  return (
    <>
      <header>
        <Container className={styles.header}>
          <span className={styles.brand}>{common('productName')}</span>
          <LanguageSwitcher
            label={common('languageSwitcher')}
            current={locale}
            options={languages}
          />
        </Container>
      </header>
      <main>
        <Container className={styles.main}>
          <h1 className={styles.title}>{t('title')}</h1>
          <p className={styles.subtitle}>{t('subtitle')}</p>
        </Container>
      </main>
    </>
  );
}
