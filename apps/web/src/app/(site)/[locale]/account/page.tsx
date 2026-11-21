import { formatPhone, notificationPreferencesSchema } from '@integris/shared';
import { AuthCard, AuthHeading, AuthPageLayout, ButtonLink } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AccountSecurity } from '../../../../components/auth/AccountForms';
import styles from '../../../../components/auth/auth-forms.module.css';
import { ApiUnavailable, AuthBrand, authMetadata } from '../../../../components/auth/AuthChrome';
import { LogoutButton } from '../../../../components/auth/LogoutButton';
import { SignedInBar } from '../../../../components/auth/SignedInBar';
import { NotificationPreferences } from '../../../../components/notifications/NotificationPreferences';
import { getPathname } from '../../../../i18n/navigation';
import { fetchAuthConfig } from '../../../../lib/auth-config';
import { serverGet } from '../../../../lib/server-api';
import { homePath, requireMe } from '../../../../lib/session';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Account' });
  return authMetadata(t('metaTitle'));
}

/** Account security: e-mail, password, notifications by e-mail, sessions (screen without mockup). */
export default async function AccountPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMe(locale);
  const [config, preferences] = await Promise.all([
    fetchAuthConfig(),
    serverGet('notifications/preferences', notificationPreferencesSchema),
  ]);
  const t = await getTranslations('Account');
  const tn = await getTranslations('Notifications.preferences');

  return (
    <AuthPageLayout
      brand={<AuthBrand locale={locale} />}
      barEnd={<SignedInBar me={me} locale={locale} path="/account" />}
      narrow
    >
      <AuthHeading title={t('title')} />
      <AuthCard>
        <section className={styles.section} aria-labelledby="account-profile">
          <h2 className={styles.sectionTitle} id="account-profile">
            {t('profile')}
          </h2>
          <dl className={styles.facts}>
            <dt>{t('name')}</dt>
            <dd>{me.user.displayName}</dd>
            <dt>{t('phone')}</dt>
            <dd>{me.user.phone ? formatPhone(me.user.phone) : '—'}</dd>
          </dl>
        </section>
      </AuthCard>
      {config ? <AccountSecurity me={me} config={config} locale={locale} /> : <ApiUnavailable />}
      {preferences && (
        <AuthCard>
          <section className={styles.section} aria-labelledby="account-notifications">
            <h2 className={styles.sectionTitle} id="account-notifications">
              {tn('title')}
            </h2>
            <NotificationPreferences initial={preferences} />
          </section>
        </AuthCard>
      )}
      <AuthCard>
        <section className={styles.section} aria-labelledby="account-sessions">
          <h2 className={styles.sectionTitle} id="account-sessions">
            {t('sessionsTitle')}
          </h2>
          <p className={styles.muted}>{t('sessionsText')}</p>
          <div>
            <LogoutButton everywhere />
          </div>
        </section>
      </AuthCard>
      <div>
        <ButtonLink href={getPathname({ href: homePath(me), locale })} variant="secondary">
          {t('back')}
        </ButtonLink>
      </div>
    </AuthPageLayout>
  );
}
