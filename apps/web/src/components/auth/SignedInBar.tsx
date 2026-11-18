import type { MeResponse } from '@integris/shared';
import type { Locale } from 'next-intl';
import styles from './auth-forms.module.css';
import { AuthLanguages } from './AuthChrome';
import { LogoutButton } from './LogoutButton';

/** Right side of the top bar for signed-in pages: language, user name, sign out. */
export function SignedInBar({
  me,
  locale,
  path,
}: {
  me: MeResponse;
  locale: Locale;
  path: string;
}) {
  return (
    <>
      <AuthLanguages locale={locale} path={path} />
      <span className={styles.user}>{me.user.displayName}</span>
      <LogoutButton />
    </>
  );
}
