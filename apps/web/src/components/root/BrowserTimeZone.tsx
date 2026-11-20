'use client';

import { NextIntlClientProvider, useLocale } from 'next-intl';
import { type ReactNode, useSyncExternalStore } from 'react';

const subscribe = () => () => undefined;

/** Time zone of the browser, when it is one Intl knows. */
function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Dates shown and typed in the time zone of the browser. The page is first drawn in the time
 * zone of the server (the same as the HTML it hydrates), then in the user's own.
 */
export function BrowserTimeZone({ children }: { children: ReactNode }) {
  const locale = useLocale();
  const timeZone = useSyncExternalStore(subscribe, browserTimeZone, () => undefined);
  return (
    <NextIntlClientProvider locale={locale} timeZone={timeZone}>
      {children}
    </NextIntlClientProvider>
  );
}
