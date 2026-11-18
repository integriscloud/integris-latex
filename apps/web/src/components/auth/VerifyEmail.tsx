'use client';

import { Alert } from '@integris/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { Link } from '../../i18n/navigation';
import { apiPost, type ClientError } from '../../lib/api-client';
import { takeTokenFromHash } from './token-from-hash';
import { useErrorMessage } from './use-auth-request';

type State = { kind: 'verifying' } | { kind: 'done' } | { kind: 'error'; error?: ClientError };

/** Confirms the address from the e-mailed link as soon as the page opens. */
export function VerifyEmail() {
  const t = useTranslations('Auth.verifyEmail');
  const message = useErrorMessage();
  const [state, setState] = useState<State>({ kind: 'verifying' });
  const started = useRef(false);

  useEffect(() => {
    // A token is usable once: never send it twice (React runs effects twice in development).
    if (started.current) return;
    started.current = true;
    const token = takeTokenFromHash();
    if (!token) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the fragment exists only in the browser
      setState({ kind: 'error' });
      return;
    }
    void apiPost('auth/email/verify', { token }).then((result) =>
      setState(result.ok ? { kind: 'done' } : { kind: 'error', error: result.error }),
    );
  }, []);

  if (state.kind === 'verifying') return <Alert tone="info">{t('verifying')}</Alert>;
  if (state.kind === 'done') {
    return (
      <Alert tone="success">
        <span>{t('done')}</span>
        <Link href="/account">{t('account')}</Link>
      </Alert>
    );
  }
  return <Alert tone="error">{state.error ? message(state.error) : t('missingToken')}</Alert>;
}
