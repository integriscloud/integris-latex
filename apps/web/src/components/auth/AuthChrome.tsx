import { Alert, LanguageSwitcher, Logo } from '@integris/ui';
import type { Metadata } from 'next';
import type { Locale } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { getPathname } from '../../i18n/navigation';
import { routing } from '../../i18n/routing';

/** Product logo linking to the home page; `inverted` for the dark column. */
export async function AuthBrand({ locale, inverted }: { locale: Locale; inverted?: boolean }) {
  const t = await getTranslations('Common');
  return (
    <Logo name={t('productName')} href={getPathname({ href: '/', locale })} inverted={inverted} />
  );
}

/** Language switcher that stays on the current page. */
export async function AuthLanguages({ locale, path }: { locale: Locale; path: string }) {
  const t = await getTranslations('Common');
  return (
    <LanguageSwitcher
      label={t('languageSwitcher')}
      current={locale}
      options={routing.locales.map((code) => ({
        locale: code,
        label: code.toUpperCase(),
        name: t(`languages.${code}`),
        href: getPathname({ href: path, locale: code }),
      }))}
    />
  );
}

/** Shown when the API cannot be reached (configuration of the forms unavailable). */
export async function ApiUnavailable() {
  const t = await getTranslations('Auth.errors');
  return <Alert tone="error">{t('network')}</Alert>;
}

/** Metadata of an account page: these pages are never indexed. */
export function authMetadata(title: string): Metadata {
  return { title, robots: { index: false, follow: false } };
}
