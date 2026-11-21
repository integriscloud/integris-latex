'use client';

import type { JoinResult, MyJoinRequest } from '@integris/shared';
import { Alert, Button, TextField } from '@integris/ui';
import { useFormatter, useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { apiPost, type ClientError } from '../../lib/api-client';
import styles from './org.module.css';
import { useOrgErrorMessage } from './use-org-error';

/**
 * "Rejoindre un établissement": a teacher types the code given by their institution; the request
 * waits for an admin, who confirms it (a seat is then taken) or refuses it.
 */
export function JoinWithCode({ requests }: { requests: MyJoinRequest[] }) {
  const t = useTranslations('JoinOrganization');
  const format = useFormatter();
  const errorMessage = useOrgErrorMessage();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  const [sent, setSent] = useState<JoinResult | null>(null);
  const [pending, setPending] = useState(requests);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await apiPost<JoinResult>('organizations/join', { code });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSent(result.data);
    setCode('');
    setPending((list) => [
      ...list,
      {
        organizationId: '',
        organizationName: result.data.organizationName,
        requestedAt: new Date().toISOString(),
      },
    ]);
  };

  return (
    <div className={styles.stack}>
      <form className={styles.form} onSubmit={submit}>
        <p className={styles.muted}>{t('help')}</p>
        <div className={styles.inline}>
          <TextField
            label={t('code')}
            value={code}
            required
            autoComplete="off"
            autoCapitalize="characters"
            maxLength={32}
            onChange={(event) => setCode(event.target.value)}
          />
          <Button type="submit" busy={busy}>
            {t('send')}
          </Button>
        </div>
        {error && (
          <Alert tone="error">
            <p>{errorMessage(error)}</p>
          </Alert>
        )}
        {sent && (
          <Alert tone="success">
            <p>{t('sent', { organization: sent.organizationName })}</p>
          </Alert>
        )}
      </form>
      {pending.length > 0 && (
        <section aria-labelledby="join-pending">
          <h2 id="join-pending" className={styles.name}>
            {t('pendingTitle')}
          </h2>
          <ul className={styles.list}>
            {pending.map((request) => (
              <li
                key={`${request.organizationName}-${request.requestedAt}`}
                className={styles.item}
              >
                <div className={styles.who}>
                  <p className={styles.name}>{request.organizationName}</p>
                  <p className={styles.muted}>
                    {t('pendingSince', {
                      date: format.dateTime(new Date(request.requestedAt), {
                        day: 'numeric',
                        month: 'long',
                      }),
                    })}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
