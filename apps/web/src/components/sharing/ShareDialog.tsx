'use client';

import {
  type AuthConfig,
  formatPhone,
  type ProjectSharing,
  SHARE_MESSAGE_MAX,
  SHAREABLE_ROLES,
  type ShareableRole,
  type ShareLinkInfo,
} from '@integris/shared';
import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  Checkbox,
  ChoiceCards,
  Dialog,
  IconButton,
  PhoneField,
  Tabs,
  TextAreaField,
  TextField,
} from '@integris/ui';
import { Check, Copy, Mail, Smartphone, UserMinus } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { getPathname } from '../../i18n/navigation';
import { apiRead, apiRequest, type ClientError } from '../../lib/api-client';
import { useApiErrorMessage } from '../app/use-api-error';
import styles from './sharing.module.css';

type Channel = 'phone' | 'email';

/** Last day of an optional expiry (a date field) as an instant: the end of that day. */
const endOfDay = (date: string) => new Date(`${date}T23:59:59`).toISOString();
const today = () => {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

export interface ShareDialogProps {
  projectId: string;
  projectName: string;
  open: boolean;
  onClose: () => void;
}

/**
 * Sharing of a project, from the editor and the project page: invitation by phone or e-mail with
 * a role and an optional message, people who have access (roles, removal), and the public
 * read-only link. Only the owner changes anything; the others see who has access.
 */
export function ShareDialog({ projectId, projectName, open, onClose }: ShareDialogProps) {
  const t = useTranslations('Sharing');
  const tApp = useTranslations('App');
  const locale = useLocale();
  const format = useFormatter();
  const errorMessage = useApiErrorMessage(locale);

  const [sharing, setSharing] = useState<ProjectSharing | null>(null);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [loadError, setLoadError] = useState<ClientError | null>(null);

  const [channel, setChannel] = useState<Channel>('phone');
  const [dialCode, setDialCode] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<ShareableRole>('EDITOR');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [inviteError, setInviteError] = useState<ClientError | null>(null);
  const [sent, setSent] = useState(false);

  const [actionError, setActionError] = useState<ClientError | null>(null);
  const [includeSources, setIncludeSources] = useState(false);
  const [expiry, setExpiry] = useState('');
  const [copied, setCopied] = useState(false);

  const fetchPanel = useCallback(
    () =>
      Promise.all([
        apiRead<ProjectSharing>(`projects/${projectId}/sharing`),
        apiRead<AuthConfig>('auth/config'),
      ]),
    [projectId],
  );

  const show = useCallback(([panel, auth]: Awaited<ReturnType<typeof fetchPanel>>) => {
    if (panel.ok) {
      setSharing(panel.data);
      setLoadError(null);
    } else {
      setLoadError(panel.error);
    }
    if (auth.ok) {
      setConfig(auth.data);
      setDialCode((current) => current || auth.data.allowedDialCodes[0] || '');
    }
  }, []);

  const load = useCallback(async () => show(await fetchPanel()), [fetchPanel, show]);

  // Read each time the dialog opens: others may have accepted or been removed meanwhile.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetchPanel().then((results) => {
      if (!cancelled) show(results);
    });
    return () => {
      cancelled = true;
    };
  }, [open, fetchPanel, show]);

  // A project read-only beyond the plan's limits is shared for reading only (no Editor role).
  const readOnly = sharing?.readOnly ?? false;
  const inviteRoles = readOnly
    ? SHAREABLE_ROLES.filter((value) => value !== 'EDITOR')
    : SHAREABLE_ROLES;
  const inviteRole: ShareableRole = readOnly && role === 'EDITOR' ? 'REVIEWER' : role;

  const roleNames: Record<ShareableRole, string> = {
    EDITOR: t('roles.EDITOR'),
    SUPERVISOR: t('roles.SUPERVISOR'),
    REVIEWER: t('roles.REVIEWER'),
    VIEWER: t('roles.VIEWER'),
  };

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setInviteError(null);
    setSent(false);
    const body =
      channel === 'phone'
        ? { channel, phone, dialCode, role: inviteRole, message: message || undefined }
        : { channel, email, role: inviteRole, message: message || undefined };
    const result = await apiRequest<ProjectSharing>(
      'POST',
      `projects/${projectId}/invitations`,
      body,
    );
    setBusy(false);
    if (!result.ok) {
      setInviteError(result.error);
      return;
    }
    setSharing(result.data);
    setSent(true);
    setPhone('');
    setEmail('');
    setMessage('');
  };

  /** A change of the owner; the panel comes back from the API when it has one. */
  const change = async (
    method: 'PATCH' | 'DELETE' | 'POST',
    path: string,
    body: object = {},
  ): Promise<boolean> => {
    setActionError(null);
    const result = await apiRequest<ProjectSharing | ShareLinkInfo | undefined>(method, path, body);
    if (!result.ok) {
      setActionError(result.error);
      return false;
    }
    if (result.data && 'members' in result.data) setSharing(result.data);
    else await load();
    return true;
  };

  const createLink = async () => {
    const done = await change('POST', `projects/${projectId}/links`, {
      includeSources,
      expiresAt: expiry ? endOfDay(expiry) : null,
    });
    if (done) {
      setIncludeSources(false);
      setExpiry('');
    }
  };

  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // The address stays selectable in its field.
    }
  };

  const pricing = `${getPathname({ href: '/', locale })}#pricing`;
  const limitReached = inviteError?.code === 'collaborator_limit';
  const canShare = sharing?.canShare ?? false;
  const collaborators = sharing?.collaborators;

  return (
    <Dialog
      open={open}
      title={t('title', { name: projectName })}
      closeLabel={tApp('close')}
      onClose={onClose}
      actions={
        <Button variant="secondary" onClick={onClose}>
          {tApp('close')}
        </Button>
      }
    >
      {loadError && <Alert tone="error">{errorMessage(loadError)}</Alert>}
      {!sharing && !loadError && (
        <p className={styles.muted} role="status">
          {t('loading')}
        </p>
      )}

      {sharing && canShare && (
        <form className={styles.section} onSubmit={invite} aria-labelledby="share-invite-title">
          <h3 id="share-invite-title" className={styles.heading}>
            {t('inviteTitle')}
          </h3>
          <Tabs
            label={t('channel')}
            idPrefix="share-channel"
            value={channel}
            onChange={(value) => {
              setChannel(value as Channel);
              setInviteError(null);
            }}
            items={[
              { id: 'phone', label: t('byPhone'), icon: Smartphone },
              { id: 'email', label: t('byEmail'), icon: Mail },
            ]}
          />
          <div
            role="tabpanel"
            id={`share-channel-panel-${channel}`}
            aria-labelledby={`share-channel-tab-${channel}`}
          >
            {channel === 'phone' ? (
              <PhoneField
                label={t('phone')}
                dialCodes={config?.allowedDialCodes ?? []}
                dialCode={dialCode}
                onDialCodeChange={setDialCode}
                dialCodeLabel={t('dialCode')}
                value={phone}
                required
                onChange={(event) => setPhone(event.target.value)}
              />
            ) : (
              <TextField
                label={t('email')}
                type="email"
                autoComplete="off"
                value={email}
                required
                onChange={(event) => setEmail(event.target.value)}
              />
            )}
          </div>
          {readOnly && <p className={styles.muted}>{t('readOnlyRoles')}</p>}
          <ChoiceCards
            label={t('role')}
            value={inviteRole}
            onChange={setRole}
            options={inviteRoles.map((value) => ({
              value,
              title: roleNames[value],
              description: t(`roleHelp.${value}`),
            }))}
          />
          <TextAreaField
            label={t('message')}
            optionalLabel={t('optional')}
            help={t('messageHelp', { count: message.length, max: SHARE_MESSAGE_MAX })}
            value={message}
            maxLength={SHARE_MESSAGE_MAX}
            onChange={(event) => setMessage(event.target.value)}
          />
          {collaborators && (
            <p className={styles.muted}>
              {collaborators.max === null
                ? t('collaboratorsUnlimited', { used: collaborators.used })
                : t('collaborators', { used: collaborators.used, max: collaborators.max })}
            </p>
          )}
          {inviteError && (
            <Alert tone="error">
              <p>
                {limitReached
                  ? t('limitReached', { max: collaborators?.max ?? 0 })
                  : errorMessage(inviteError)}
              </p>
              {limitReached && (
                <ButtonLink href={pricing} variant="accent">
                  {t('upgrade')}
                </ButtonLink>
              )}
            </Alert>
          )}
          {sent && (
            <Alert tone="success">
              <p>{t('sent')}</p>
            </Alert>
          )}
          <Button type="submit" busy={busy}>
            {channel === 'phone' ? t('sendSms') : t('sendEmail')}
          </Button>
        </form>
      )}

      {sharing && (
        <section className={styles.section} aria-labelledby="share-people-title">
          <h3 id="share-people-title" className={styles.heading}>
            {t('people')}
          </h3>
          {!canShare && <p className={styles.muted}>{t('ownerOnly')}</p>}
          {actionError && <Alert tone="error">{errorMessage(actionError)}</Alert>}
          <ul className={styles.people}>
            <li className={styles.person}>
              <span className={styles.name}>{sharing.owner.name}</span>
              <Badge tone="action">{t('roles.OWNER')}</Badge>
            </li>
            {sharing.members.map((member) => (
              <li key={member.userId} className={styles.person}>
                <span className={styles.name}>{member.name}</span>
                {canShare ? (
                  <span className={styles.controls}>
                    <select
                      className={styles.select}
                      aria-label={t('roleOf', { name: member.name })}
                      value={member.role}
                      onChange={(event) =>
                        void change('PATCH', `projects/${projectId}/members/${member.userId}`, {
                          role: event.target.value,
                        })
                      }
                    >
                      {SHAREABLE_ROLES.map((value) => (
                        <option
                          key={value}
                          value={value}
                          disabled={readOnly && value === 'EDITOR' && member.role !== 'EDITOR'}
                        >
                          {roleNames[value]}
                        </option>
                      ))}
                    </select>
                    <IconButton
                      icon={UserMinus}
                      label={t('remove', { name: member.name })}
                      onClick={() =>
                        void change('DELETE', `projects/${projectId}/members/${member.userId}`)
                      }
                    />
                  </span>
                ) : (
                  <Badge>{roleNames[member.role as ShareableRole]}</Badge>
                )}
              </li>
            ))}
            {sharing.invitations.map((invitation) => (
              <li key={invitation.id} className={styles.person}>
                <span className={styles.name}>
                  {invitation.channel === 'phone'
                    ? formatPhone(invitation.contact)
                    : invitation.contact}
                  <span className={styles.detail}>
                    {t('pending', {
                      role: roleNames[invitation.role],
                      date: format.dateTime(new Date(invitation.expiresAt), {
                        day: 'numeric',
                        month: 'long',
                      }),
                    })}
                  </span>
                </span>
                <Button
                  variant="secondary"
                  onClick={() =>
                    void change('DELETE', `projects/${projectId}/invitations/${invitation.id}`)
                  }
                >
                  {t('cancelInvitation')}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {sharing && canShare && (
        <section className={styles.section} aria-labelledby="share-link-title">
          <h3 id="share-link-title" className={styles.heading}>
            {t('linkTitle')}
          </h3>
          <p className={styles.muted}>{t('linkHelp')}</p>
          {sharing.link ? (
            <div className={styles.link}>
              <TextField
                label={t('linkAddress')}
                value={sharing.link.url}
                readOnly
                className={styles.url}
                onFocus={(event) => event.target.select()}
              />
              <p className={styles.muted}>
                {sharing.link.includeSources ? t('linkWithSources') : t('linkPdfOnly')} ·{' '}
                {sharing.link.expiresAt
                  ? t('linkExpires', {
                      date: format.dateTime(new Date(sharing.link.expiresAt), {
                        day: 'numeric',
                        month: 'long',
                        year: 'numeric',
                      }),
                    })
                  : t('linkNoExpiry')}
              </p>
              <div className={styles.row}>
                <Button variant="secondary" onClick={() => void copyLink(sharing.link!.url)}>
                  {copied ? (
                    <Check size={20} strokeWidth={1.75} aria-hidden="true" />
                  ) : (
                    <Copy size={20} strokeWidth={1.75} aria-hidden="true" />
                  )}
                  {copied ? t('copied') : t('copy')}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() =>
                    void change('DELETE', `projects/${projectId}/links/${sharing.link!.id}`)
                  }
                >
                  {t('revoke')}
                </Button>
              </div>
            </div>
          ) : (
            <div className={styles.link}>
              <Checkbox
                checked={includeSources}
                onChange={(event) => setIncludeSources(event.target.checked)}
              >
                {t('includeSources')}
              </Checkbox>
              <TextField
                label={t('expiry')}
                optionalLabel={t('optional')}
                type="date"
                min={today()}
                value={expiry}
                onChange={(event) => setExpiry(event.target.value)}
              />
              <Button variant="secondary" onClick={() => void createLink()}>
                {t('createLink')}
              </Button>
            </div>
          )}
        </section>
      )}
    </Dialog>
  );
}
