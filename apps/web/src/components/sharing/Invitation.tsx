'use client';

import type { InvitationView } from '@integris/shared';
import { Alert, Badge, Button, ButtonLink } from '@integris/ui';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { getPathname } from '../../i18n/navigation';
import { apiPost, type ClientError } from '../../lib/api-client';
import { useApiErrorMessage } from '../app/use-api-error';
import { invitationTokenFromHash } from '../auth/token-from-hash';
import styles from './sharing.module.css';

type State =
  | { kind: 'loading' }
  | { kind: 'invalid'; error?: ClientError }
  | { kind: 'shown'; token: string; view: InvitationView }
  | { kind: 'declined' };

/**
 * Invitation to a project, opened from the SMS or e-mail link (`#token=…`). Signed out: sign in
 * or create the account of the invited phone or e-mail, then come back here. Signed in: accept
 * (the project opens) or decline.
 */
export function Invitation({ signedInAs }: { signedInAs: string | null }) {
  const t = useTranslations('Invitation');
  const tRoles = useTranslations('Sharing');
  const locale = useLocale();
  const format = useFormatter();
  const errorMessage = useApiErrorMessage(locale);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  const [error, setError] = useState<ClientError | null>(null);

  useEffect(() => {
    const token = invitationTokenFromHash();
    let cancelled = false;
    void (
      token ? apiPost<InvitationView>('invitations/view', { token }) : Promise.resolve(null)
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
    const result = await apiPost<{ projectId: string }>('invitations/accept', { token });
    if (result.ok) {
      window.location.assign(
        getPathname({ href: `/app/projects/${result.data.projectId}`, locale }),
      );
      return;
    }
    setBusy(null);
    setError(result.error);
  };
  const decline = async () => {
    setBusy('decline');
    setError(null);
    const result = await apiPost('invitations/decline', { token });
    setBusy(null);
    if (result.ok) setState({ kind: 'declined' });
    else setError(result.error);
  };

  const signIn = `${getPathname({ href: '/login', locale })}#invite=${token}`;
  const signUp = `${getPathname({ href: '/signup', locale })}#invite=${token}`;
  const until = format.dateTime(new Date(view.expiresAt), {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  return (
    <div className={styles.section}>
      <p className={styles.lead}>
        {t('text', { inviter: view.inviterName, project: view.projectName })}
      </p>
      <p className={styles.row}>
        <Badge tone="action">{tRoles(`roles.${view.role}`)}</Badge>
        <span className={styles.muted}>{tRoles(`roleHelp.${view.role}`)}</span>
      </p>
      {view.message && (
        <figure className={styles.message}>
          <blockquote>{view.message}</blockquote>
          <figcaption>{view.inviterName}</figcaption>
        </figure>
      )}
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
              {error.code === 'invitation_other_account' && view.channel === 'email' && (
                <a href={getPathname({ href: '/account', locale })}>{t('account')}</a>
              )}
            </Alert>
          )}
          <div className={styles.row}>
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
          <div className={styles.row}>
            <ButtonLink href={signIn}>{t('signIn')}</ButtonLink>
            <ButtonLink href={signUp} variant="secondary">
              {t('signUp')}
            </ButtonLink>
          </div>
        </>
      )}
    </div>
  );
}
