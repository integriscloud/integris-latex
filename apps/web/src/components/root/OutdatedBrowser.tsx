import { Alert } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import {
  buildMinimums,
  OUTDATED_BANNER_ID,
  outdatedBrowserScript,
} from '../../lib/browsers/outdated';
import styles from './outdated-browser.module.css';
import { ServerOnlyScript } from './ServerOnlyScript';

/**
 * Banner of a browser older than the target (docs/spec.md, "Navigateurs"), on every page. It is
 * hidden in the HTML and shown by an inline ES5 script, before and without the app's bundles; it
 * only advises, it never blocks the page.
 */
export async function OutdatedBrowser({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: 'OutdatedBrowser' });
  const tCommon = await getTranslations({ locale, namespace: 'Common' });
  return (
    <>
      <div id={OUTDATED_BANNER_ID} className={styles.banner} hidden suppressHydrationWarning>
        <Alert tone="warning" announce={false}>
          <p className={styles.text}>
            <strong>{t('title')}</strong>{' '}
            {t.rich('text', {
              product: tCommon('productName'),
              chrome: (chunks) => (
                <a href={t('chromeUrl')} rel="noopener noreferrer">
                  {chunks}
                </a>
              ),
              firefox: (chunks) => (
                <a href={t('firefoxUrl')} rel="noopener noreferrer">
                  {chunks}
                </a>
              ),
            })}
          </p>
        </Alert>
      </div>
      <ServerOnlyScript html={outdatedBrowserScript(buildMinimums())} />
    </>
  );
}
