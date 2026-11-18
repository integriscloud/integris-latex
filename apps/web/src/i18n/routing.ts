import { DEFAULT_LOCALE, LOCALES } from '@integris/shared';
import { defineRouting } from 'next-intl/routing';

export const routing = defineRouting({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  // Every page lives under /fr or /en; "/" redirects to the visitor's locale (French by default).
  // 'as-needed' relies on an internal rewrite that Next.js 16.4 sends back through the proxy,
  // which then redirects /fr to / in a loop.
  localePrefix: 'always',
});
