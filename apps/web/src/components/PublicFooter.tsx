import { Logo, SiteFooter } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { getPathname } from '../i18n/navigation';

export async function PublicFooter({ locale }: { locale: Locale }) {
  const t = await getTranslations('Common');
  const home = getPathname({ href: '/', locale });
  const page = (href: string) => getPathname({ href, locale });

  return (
    <SiteFooter
      brand={<Logo name={t('productName')} href={home} />}
      tagline={t('footer.tagline')}
      columns={[
        {
          title: t('footer.product'),
          links: [
            { href: `${home}#features`, label: t('nav.features') },
            { href: `${home}#supervision`, label: t('nav.supervision') },
            { href: `${home}#pricing`, label: t('nav.pricing') },
            { href: `${home}#faq`, label: t('nav.faq') },
          ],
        },
        {
          title: t('footer.account'),
          links: [
            { href: page('/login'), label: t('nav.login') },
            { href: page('/signup'), label: t('nav.signup') },
          ],
        },
        {
          title: t('footer.legal'),
          links: [
            { href: page('/terms'), label: t('footer.terms') },
            { href: page('/privacy'), label: t('footer.privacy') },
          ],
        },
      ]}
      legal={t('footer.copyright', { year: new Date().getFullYear() })}
    />
  );
}
