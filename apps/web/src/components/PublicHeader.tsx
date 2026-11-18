import { ButtonLink, LanguageSwitcher, Logo, SiteHeader } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { getPathname } from '../i18n/navigation';
import { routing } from '../i18n/routing';

interface PublicHeaderProps {
  locale: Locale;
  /** Path of the current page, so the language switcher stays on it. */
  path: string;
}

/** Header of the public pages: logo, anchors of the home page, log in, sign up, language. */
export async function PublicHeader({ locale, path }: PublicHeaderProps) {
  const t = await getTranslations('Common');
  const home = getPathname({ href: '/', locale });

  const languages = routing.locales.map((code) => ({
    locale: code,
    label: code.toUpperCase(),
    name: t(`languages.${code}`),
    href: getPathname({ href: path, locale: code }),
  }));

  return (
    <SiteHeader
      brand={<Logo name={t('productName')} href={home} />}
      navLabel={t('nav.label')}
      menuLabel={t('nav.menu')}
      links={[
        { href: `${home}#features`, label: t('nav.features') },
        { href: `${home}#supervision`, label: t('nav.supervision') },
        { href: `${home}#pricing`, label: t('nav.pricing') },
        { href: `${home}#faq`, label: t('nav.faq') },
      ]}
      secondaryActions={
        <>
          <LanguageSwitcher label={t('languageSwitcher')} current={locale} options={languages} />
          <ButtonLink href={getPathname({ href: '/login', locale })} variant="secondary">
            {t('nav.login')}
          </ButtonLink>
        </>
      }
      actions={
        <ButtonLink href={getPathname({ href: '/signup', locale })}>{t('nav.signup')}</ButtonLink>
      }
    />
  );
}
