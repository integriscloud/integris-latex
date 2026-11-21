'use client';

import type { MeResponse, OrgInvitationView } from '@integris/shared';
import { Alert, Button, ButtonLink } from '@integris/ui';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { getPathname } from '../../i18n/navigation';
import { apiPost, type ClientError } from '../../lib/api-client';
import { invitationTokenFromHash } from '../auth/token-from-hash';
import styles from './org.module.css';
import { useOrgErrorMessage } from './use-org-error';

type State =
  | { kind: 'loading' }
  | { kind: 'invalid'; error?: ClientError }
  | { kind: 'shown'; token: string; view: OrgInvitationView }
  | { kind: 'declined' };

/**
 * Invitation to join an organization, opened from the SMS or e-mail link (`/join#token=…`).
 * Signed out: sign in or create the account of the invited phone or e-mail, then come back here.
 * Accepting takes the seat reserved for the invitation and opens the organization's space.
 */
export function OrgInvitation({ signedInAs }: { signedInAs: string | null }) {
  const t = useTranslations('OrgInvitation');
  const tKinds = useTranslations('Organization');
  const locale = useLocale();
  const format = useFormatter();
  const errorMessage = useOrgErrorMessage();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  const [error, setError] = useState<ClientError | null>(null);

  useEffect(() => {
    const token = invitationTokenFromHash();
    let cancelled = false;
    void (
      token ? apiPost<OrgInvitationView>('org-invitations/view', { token }) : Promise.resolve(null)
    ).then((result) => {
      if (cancelled) return;
      if (!token || !result) setState({ kind: 'invalid' });
      else if (result.ok) setState({ kind: 'shown', token, view: result.data });
      else setState({ kind: 'invalid', error: result.error });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'loading') {
    return (
      <p className={styles.muted} role="status">
        {t('loading')}
      </p>
    );
  }
  if (state.kind === 'invalid') {
    return (
      <Alert tone="error">
        <p>
          {state.error && state.error.code !== 'invitation_invalid'
            ? errorMessage(state.error)
            : t('invalid')}
        </p>
      </Alert>
    );
  }
  if (state.kind === 'declined') {
    return (
      <Alert tone="info">
        <p>{t('declined')}</p>
      </Alert>
    );
  }

  const { token, view } = state;
  const accept = async () => {
    setBusy('accept');
    setError(null);
    const result = await apiPost<{ organizationId: string }>('org-invitations/accept', { token });
    if (result.ok) {
      // The new space opens at once.
      await apiPost<MeResponse>('auth/space', { spaceId: result.data.organizationId });
      window.location.assign(getPathname({ href: '/app/org', locale }));
      return;
    }
    setBusy(null);
    setError(result.error);
  };
  const decline = async () => {
    setBusy('decline');
    setError(null);
    const result = await apiPost('org-invitations/decline', { token });
    setBusy(null);
    if (result.ok) setState({ kind: 'declined' });
    else setError(result.error);
  };

  const until = format.dateTime(new Date(view.expiresAt), {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  return (
    <div className={styles.form}>
      <p>{t('text', { inviter: view.inviterName, organization: view.organizationName })}</p>
      {view.organizationType === 'BUSINESS' && (
        <p className={styles.muted}>{t('as', { kind: tKinds(`kinds.${view.kind}`) })}</p>
      )}
      <p className={styles.muted}>{t('seat')}</p>
      <p className={styles.muted}>
        {t(view.channel === 'phone' ? 'sentToPhone' : 'sentToEmail', {
          contact: view.contactHint,
          date: until,
        })}
      </p>
      {view.status !== 'PENDING' ? (
        <Alert tone={view.status === 'ACCEPTED' ? 'success' : 'info'}>
          <p>{t(`status.${view.status}`)}</p>
        </Alert>
      ) : signedInAs ? (
        <>
          <p className={styles.muted}>{t('signedInAs', { name: signedInAs })}</p>
          {error && (
            <Alert tone="error">
              <p>
                {error.code === 'invitation_other_account'
                  ? t(view.channel === 'phone' ? 'otherPhone' : 'otherEmail', {
                      contact: view.contactHint,
                    })
                  : errorMessage(error)}
              </p>
            </Alert>
          )}
          <div className={styles.actions}>
            <Button busy={busy === 'accept'} onClick={() => void accept()}>
              {t('accept')}
            </Button>
            <Button variant="secondary" busy={busy === 'decline'} onClick={() => void decline()}>
              {t('decline')}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className={styles.muted}>
            {t(view.channel === 'phone' ? 'signInPhone' : 'signInEmail', {
              contact: view.contactHint,
            })}
          </p>
          <div className={styles.actions}>
            <ButtonLink href={`${getPathname({ href: '/login', locale })}#join=${token}`}>
              {t('signIn')}
            </ButtonLink>
            <ButtonLink
              href={`${getPathname({ href: '/signup', locale })}#join=${token}`}
              variant="secondary"
            >
              {t('signUp')}
            </ButtonLink>
          </div>
        </>
      )}
    </div>
  );
}
