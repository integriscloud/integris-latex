'use client';

import { Button } from '@integris/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useRouter } from '../../i18n/navigation';
import { apiPost } from '../../lib/api-client';

/** Signs out this session (or every session) and goes back to the sign-in page. */
export function LogoutButton({ everywhere = false }: { everywhere?: boolean }) {
  const t = useTranslations('Account');
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const logout = async () => {
    setBusy(true);
    await apiPost(everywhere ? 'auth/logout-all' : 'auth/logout');
    router.replace('/login');
    router.refresh();
  };

  return (
    <Button variant={everywhere ? 'secondary' : 'ghost'} busy={busy} onClick={logout}>
      {busy ? t('loggingOut') : everywhere ? t('logoutAll') : t('logout')}
    </Button>
  );
}
