'use client';

import { Dialog } from '@integris/ui';
import { useTranslations } from 'next-intl';
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from 'react';
import type { ApiResult } from '../../lib/api-client';
import { ReauthPanel } from '../auth/ReauthPanel';

type Run = <T>(call: () => Promise<ApiResult<T>>) => Promise<ApiResult<T>>;

const AdminActions = createContext<Run | null>(null);

/**
 * Sensitive actions of the back-office: when the API asks for the back-office SMS code
 * (`admin_reauth_required`), a dialog asks for it, then the action is sent again once.
 */
export function AdminActionsProvider({
  phone,
  otpLength,
  locale,
  children,
}: {
  phone: string | null;
  otpLength: number;
  locale: string;
  children: ReactNode;
}) {
  const t = useTranslations('Admin.reauth');
  const [open, setOpen] = useState(false);
  const waiting = useRef<((confirmed: boolean) => void) | null>(null);

  const close = (confirmed: boolean) => {
    setOpen(false);
    waiting.current?.(confirmed);
    waiting.current = null;
  };

  const run = useCallback<Run>(async (call) => {
    const first = await call();
    if (first.ok || first.error.code !== 'admin_reauth_required') return first;
    const confirmed = await new Promise<boolean>((resolve) => {
      waiting.current = resolve;
      setOpen(true);
    });
    return confirmed ? call() : first;
  }, []);

  return (
    <AdminActions.Provider value={run}>
      {children}
      <Dialog
        open={open}
        title={t('dialogTitle')}
        closeLabel={t('close')}
        onClose={() => close(false)}
        actions={null}
      >
        {phone ? (
          <ReauthPanel
            scope="admin"
            phone={phone}
            locale={locale}
            otpLength={otpLength}
            onConfirmed={() => close(true)}
          />
        ) : (
          <p>{t('noPhone')}</p>
        )}
      </Dialog>
    </AdminActions.Provider>
  );
}

/** Runs a back-office request, asking for the SMS code first when it is needed. */
export function useAdminAction(): Run {
  const run = useContext(AdminActions);
  if (!run) throw new Error('useAdminAction outside AdminActionsProvider');
  return run;
}
