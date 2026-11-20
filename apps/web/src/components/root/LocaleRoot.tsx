import type { Metadata } from 'next';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { routing } from '../../i18n/routing';
import { BrowserTimeZone } from './BrowserTimeZone';
import { OutdatedBrowser } from './OutdatedBrowser';

/**
 * The app has two root layouts (route groups): the site, with the three faces, and the editor,
 * which only loads Plus Jakarta Sans and JetBrains Mono (docs/design/README.md). Both render
 * this document shell; going from one to the other reloads the page.
 */
export interface LocaleLayoutProps {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}

export function localeStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function localeMetadata({ params }: LocaleLayoutProps): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: 'Metadata' });
  return { title: t('title'), description: t('description') };
}

export async function LocaleRoot({
  params,
  fontClasses,
  bodyClassName,
  children,
}: LocaleLayoutProps & { fontClasses: string; bodyClassName?: string }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  return (
    <html lang={locale} className={fontClasses}>
      <body className={bodyClassName}>
        <OutdatedBrowser locale={locale} />
        <NextIntlClientProvider>
          <BrowserTimeZone>{children}</BrowserTimeZone>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
