'use client';

import {
  type AuthConfig,
  CSV_IMPORT_MAX_BYTES,
  type ImportReport,
  type MembersPage,
  type OrgMember,
  type OrganizationView,
} from '@integris/shared';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  FileDrop,
  Panel,
  PhoneField,
  SelectField,
  Tabs,
  TextField,
} from '@integris/ui';
import { Mail, Smartphone } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useState } from 'react';
import { apiRead, apiRequest, apiUpload, type ClientError } from '../../lib/api-client';
import { formatBytes } from '../../lib/format';
import { groupLabel, ScopeGroupsDialog, ScopeGroupsField } from './ScopeGroups';
import styles from './org.module.css';
import { useOrgErrorMessage } from './use-org-error';

type Channel = 'phone' | 'email';

/**
 * "Utilisateurs" (mockup etablissement-02, rebuilt plain): invite by phone or e-mail (a seat is
 * reserved), import a CSV (BUSINESS), confirm teachers' join requests, cancel invitations, and
 * manage members: kind, group, admin role (owner only), removal. Consumption is shown as counts,
 * never projects.
 */
export function MembersView({
  organization,
  initial,
  meId,
}: {
  organization: OrganizationView;
  initial: MembersPage;
  meId: string;
}) {
  const t = useTranslations('Members');
  const tOrg = useTranslations('Organization');
  const tApp = useTranslations('App');
  const locale = useLocale();
  const format = useFormatter();
  const errorMessage = useOrgErrorMessage();
  const [page, setPage] = useState(initial);
  const [error, setError] = useState<ClientError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [channel, setChannel] = useState<Channel>('phone');
  const [dialCode, setDialCode] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [kind, setKind] = useState('STUDENT');
  const [groupId, setGroupId] = useState('');
  const [inviteError, setInviteError] = useState<ClientError | null>(null);
  const [invited, setInvited] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [importError, setImportError] = useState<ClientError | null>(null);
  const [removing, setRemoving] = useState<OrgMember | null>(null);
  const [approveGroups, setApproveGroups] = useState<Record<string, string>>({});
  const [scopeIds, setScopeIds] = useState<string[]>([]);
  const [scopeTried, setScopeTried] = useState(false);
  const [scoping, setScoping] = useState<OrgMember | null>(null);

  const id = organization.id;
  const business = organization.type === 'BUSINESS';
  const isOwner = organization.me.role === 'OWNER';
  const groupOptions = [
    { value: '', label: t('noGroup') },
    ...page.groups.map((group) => ({ value: group.id, label: group.name })),
  ];
  const groupName = (groupId: string | null) =>
    page.groups.find((group) => group.id === groupId)?.name ?? null;
  const kindOptions = (['STUDENT', 'TEACHER', 'SECRETARY'] as const).map((value) => ({
    value,
    label: tOrg(`kinds.${value}`),
  }));

  useEffect(() => {
    void apiRead<AuthConfig>('auth/config').then((result) => {
      if (!result.ok) return;
      setConfig(result.data);
      setDialCode((current) => current || result.data.allowedDialCodes[0] || '');
    });
  }, []);

  // Follows a running import until its report is complete.
  const importId = report?.status === 'PROCESSING' ? report.id : null;
  useEffect(() => {
    if (!importId) return;
    const timer = setInterval(() => {
      void apiRead<ImportReport>(`organizations/${id}/imports/${importId}`).then(async (result) => {
        if (!result.ok || result.data.status === 'PROCESSING') return;
        setReport(result.data);
        const members = await apiRead<MembersPage>(`organizations/${id}/members`);
        if (members.ok) setPage(members.data);
      });
    }, 1500);
    return () => clearInterval(timer);
  }, [id, importId]);

  const run = async (
    key: string,
    call: () => Promise<{ ok: boolean; data?: unknown; error?: ClientError }>,
  ) => {
    setBusy(key);
    setError(null);
    const result = await call();
    setBusy(null);
    if (result.ok) {
      if (result.data) setPage(result.data as MembersPage);
      return true;
    }
    setError(result.error ?? null);
    return false;
  };

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    // A secretariat serves at least one group, chosen before the invitation is sent.
    if (business && kind === 'SECRETARY' && !scopeIds.length) {
      setScopeTried(true);
      return;
    }
    setBusy('invite');
    setInviteError(null);
    setInvited(false);
    const target = channel === 'phone' ? { channel, phone, dialCode } : { channel, email };
    const result = await apiRequest<MembersPage>('POST', `organizations/${id}/invitations`, {
      ...target,
      ...(business
        ? {
            kind,
            ...(groupId ? { groupId } : {}),
            ...(kind === 'SECRETARY' ? { scopeGroupIds: scopeIds } : {}),
          }
        : {}),
    });
    setBusy(null);
    if (!result.ok) {
      setInviteError(result.error);
      return;
    }
    setPage(result.data);
    setPhone('');
    setEmail('');
    setInvited(true);
  };

  const upload = async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    setImportError(null);
    setReport(null);
    if (file.size > CSV_IMPORT_MAX_BYTES) {
      setImportError({ code: 'csv_too_large' });
      return;
    }
    setBusy('import');
    const result = await apiUpload<ImportReport>(
      'POST',
      `organizations/${id}/imports?name=${encodeURIComponent(file.name)}`,
      file,
      'application/octet-stream',
    );
    setBusy(null);
    if (result.ok) setReport(result.data);
    else setImportError(result.error);
  };

  const usage = (member: OrgMember) => (
    <dl className={styles.usage}>
      <div>
        <dt>{t('usage.projects')}</dt>
        <dd>{member.usage.projects}</dd>
      </div>
      <div>
        <dt>{t('usage.storage')}</dt>
        <dd>{formatBytes(member.usage.storageBytes, locale)}</dd>
      </div>
      <div>
        <dt>{t('usage.compiles')}</dt>
        <dd>
          {t('usage.compilesValue', {
            count: member.usage.compiles,
            minutes: Math.ceil(member.usage.compileSeconds / 60),
          })}
        </dd>
      </div>
    </dl>
  );

  return (
    <div className={styles.stack}>
      <p className={styles.muted} aria-live="polite">
        {t('seats', {
          held: page.seats.held,
          total: page.seats.total,
          reserved: page.seats.reserved,
          free: page.seats.free,
        })}
        {page.seats.waiting > 0 && page.seats.nextFreeAt
          ? ` ${t('waiting', {
              count: page.seats.waiting,
              date: format.dateTime(new Date(page.seats.nextFreeAt), {
                day: 'numeric',
                month: 'long',
              }),
            })}`
          : ''}
      </p>
      {error && (
        <Alert tone="error">
          <p>{errorMessage(error)}</p>
        </Alert>
      )}

      <Panel title={t('invite.title')}>
        <form className={styles.form} onSubmit={invite}>
          <Tabs
            label={t('invite.channel')}
            idPrefix="org-invite-channel"
            value={channel}
            onChange={(value) => {
              setChannel(value as Channel);
              setInviteError(null);
            }}
            items={[
              { id: 'phone', label: t('invite.byPhone'), icon: Smartphone },
              { id: 'email', label: t('invite.byEmail'), icon: Mail },
            ]}
          />
          <div
            role="tabpanel"
            id={`org-invite-channel-panel-${channel}`}
            aria-labelledby={`org-invite-channel-tab-${channel}`}
          >
            {channel === 'phone' ? (
              <PhoneField
                label={t('invite.phone')}
                dialCodes={config?.allowedDialCodes ?? []}
                dialCode={dialCode}
                onDialCodeChange={setDialCode}
                dialCodeLabel={t('invite.dialCode')}
                value={phone}
                required
                onChange={(event) => setPhone(event.target.value)}
              />
            ) : (
              <TextField
                label={t('invite.email')}
                type="email"
                autoComplete="off"
                value={email}
                required
                onChange={(event) => setEmail(event.target.value)}
              />
            )}
          </div>
          {business && (
            <div className={styles.inline}>
              <SelectField
                label={t('invite.kind')}
                options={kindOptions}
                value={kind}
                onChange={(event) => setKind(event.target.value)}
              />
              <SelectField
                label={t('invite.group')}
                options={groupOptions}
                value={groupId}
                onChange={(event) => setGroupId(event.target.value)}
              />
            </div>
          )}
          {business && kind === 'SECRETARY' && (
            <ScopeGroupsField
              groups={page.groups}
              value={scopeIds}
              onChange={setScopeIds}
              invalid={scopeTried && !scopeIds.length}
            />
          )}
          <p className={styles.muted}>{t('invite.help')}</p>
          {inviteError && (
            <Alert tone="error">
              <p>{errorMessage(inviteError)}</p>
            </Alert>
          )}
          {invited && (
            <Alert tone="success">
              <p>{t('invite.sent')}</p>
            </Alert>
          )}
          <div className={styles.actions}>
            <Button type="submit" busy={busy === 'invite'}>
              {t('invite.submit')}
            </Button>
          </div>
        </form>
      </Panel>

      {business && (
        <Panel title={t('import.title')}>
          <div className={styles.form}>
            <p className={styles.muted}>{t('import.help')}</p>
            <p className={styles.muted}>{t('import.columns')}</p>
            <FileDrop
              label={t('import.choose')}
              hint={t('import.hint')}
              accept=".csv,text/csv"
              disabled={busy === 'import' || report?.status === 'PROCESSING'}
              onFiles={(files) => void upload(files)}
            />
            {importError && (
              <Alert tone="error">
                <p>{errorMessage(importError)}</p>
              </Alert>
            )}
            {report?.status === 'PROCESSING' && (
              <p className={styles.muted} role="status">
                {t('import.running', { count: report.totalRows })}
              </p>
            )}
            {report && report.status !== 'PROCESSING' && (
              <Alert tone={report.status === 'DONE' ? 'success' : 'error'}>
                <p>
                  {report.status === 'DONE'
                    ? t('import.done', {
                        invited: report.invitedCount,
                        errors: report.errors.length,
                      })
                    : t('import.failed')}
                </p>
              </Alert>
            )}
            {report && report.errors.length > 0 && (
              <section aria-labelledby="import-errors">
                <h3 id="import-errors" className={styles.name}>
                  {t('import.errorsTitle')}
                </h3>
                <ul className={styles.report}>
                  {report.errors.map((row) => (
                    <li key={row.line}>
                      {t('import.errorLine', {
                        line: row.line,
                        contact: row.contact || '—',
                        reason: t(`import.reasons.${row.reason}`),
                      })}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </Panel>
      )}

      {page.joinRequests.length > 0 && (
        <Panel title={t('requests.title', { count: page.joinRequests.length })}>
          <p className={styles.muted}>{t('requests.help')}</p>
          <ul className={styles.list}>
            {page.joinRequests.map((request) => (
              <li key={request.userId} className={styles.item}>
                <div className={styles.who}>
                  <p className={styles.name}>{request.name}</p>
                  {request.type === 'teacher' && (
                    <p className={styles.muted}>{t('requests.teacherRequest')}</p>
                  )}
                  <p className={styles.muted}>
                    {t('requests.since', {
                      contact: request.contactHint ?? '—',
                      date: format.dateTime(new Date(request.requestedAt), {
                        day: 'numeric',
                        month: 'long',
                      }),
                    })}
                  </p>
                </div>
                <div className={styles.actions}>
                  {page.groups.length > 0 && (
                    <SelectField
                      label={t('invite.group')}
                      options={groupOptions}
                      value={approveGroups[request.userId] ?? ''}
                      onChange={(event) =>
                        setApproveGroups((current) => ({
                          ...current,
                          [request.userId]: event.target.value,
                        }))
                      }
                    />
                  )}
                  <Button
                    variant="secondary"
                    busy={busy === `reject-${request.userId}`}
                    onClick={() =>
                      void run(`reject-${request.userId}`, () =>
                        apiRequest<MembersPage>(
                          'POST',
                          `organizations/${id}/join-requests/${request.userId}/reject`,
                        ),
                      )
                    }
                  >
                    {t('requests.reject')}
                  </Button>
                  <Button
                    busy={busy === `approve-${request.userId}`}
                    onClick={() =>
                      void run(`approve-${request.userId}`, () =>
                        apiRequest<MembersPage>(
                          'POST',
                          `organizations/${id}/join-requests/${request.userId}/approve`,
                          { groupId: approveGroups[request.userId] || null },
                        ),
                      )
                    }
                  >
                    {t('requests.approve')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {page.invitations.length > 0 && (
        <Panel title={t('invitations.title', { count: page.invitations.length })}>
          <ul className={styles.list}>
            {page.invitations.map((invitation) => (
              <li key={invitation.id} className={styles.item}>
                <div className={styles.who}>
                  <p className={styles.name}>{invitation.displayName ?? invitation.contact}</p>
                  <p className={styles.muted}>
                    {[
                      invitation.displayName ? invitation.contact : null,
                      business ? tOrg(`kinds.${invitation.kind}`) : null,
                      groupName(invitation.groupId),
                      t('invitations.until', {
                        date: format.dateTime(new Date(invitation.expiresAt), {
                          day: 'numeric',
                          month: 'long',
                        }),
                      }),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  busy={busy === `revoke-${invitation.id}`}
                  onClick={() =>
                    void run(`revoke-${invitation.id}`, () =>
                      apiRequest<MembersPage>(
                        'DELETE',
                        `organizations/${id}/invitations/${invitation.id}`,
                      ),
                    )
                  }
                >
                  {t('invitations.revoke')}
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel title={t('list.title', { count: page.members.length })}>
        <ul className={styles.list}>
          {page.members.map((member) => {
            const canRemove =
              member.role !== 'OWNER' &&
              member.userId !== meId &&
              (isOwner || member.role !== 'ADMIN');
            return (
              <li key={member.userId} className={styles.item}>
                <div className={styles.who}>
                  <p className={styles.name}>{member.name}</p>
                  <div className={styles.badges}>
                    {member.role !== 'MEMBER' && (
                      <Badge tone="action">{tOrg(`roles.${member.role}`)}</Badge>
                    )}
                    {business && member.kind !== 'OTHER' && (
                      <Badge tone="neutral">{tOrg(`kinds.${member.kind}`)}</Badge>
                    )}
                    {groupName(member.groupId) && (
                      <Badge tone="neutral">{groupName(member.groupId)}</Badge>
                    )}
                    {member.kind === 'SECRETARY' &&
                      member.scopeGroupIds.map((scope) => (
                        <Badge key={scope} tone="info">
                          {t('secretariat.serves', { group: groupLabel(page.groups, scope) })}
                        </Badge>
                      ))}
                  </div>
                  {member.contactHint && <p className={styles.muted}>{member.contactHint}</p>}
                  {usage(member)}
                </div>
                <div className={styles.actions}>
                  {business && (isOwner || member.role === 'MEMBER') && (
                    <>
                      <SelectField
                        label={t('list.kind', { name: member.name })}
                        options={[
                          ...kindOptions,
                          ...(member.kind === 'OTHER'
                            ? [{ value: member.kind, label: tOrg(`kinds.${member.kind}`) }]
                            : []),
                        ]}
                        value={member.kind}
                        disabled={busy !== null}
                        onChange={(event) =>
                          // A new secretariat chooses its groups first.
                          event.target.value === 'SECRETARY'
                            ? setScoping(member)
                            : void run(`kind-${member.userId}`, () =>
                                apiRequest<MembersPage>(
                                  'PATCH',
                                  `organizations/${id}/members/${member.userId}`,
                                  { kind: event.target.value },
                                ),
                              )
                        }
                      />
                      {member.kind === 'SECRETARY' && (
                        <Button variant="secondary" onClick={() => setScoping(member)}>
                          {t('secretariat.change')}
                        </Button>
                      )}
                      <SelectField
                        label={t('list.group', { name: member.name })}
                        options={groupOptions}
                        value={member.groupId ?? ''}
                        disabled={busy !== null}
                        onChange={(event) =>
                          void run(`group-${member.userId}`, () =>
                            apiRequest<MembersPage>(
                              'PATCH',
                              `organizations/${id}/members/${member.userId}`,
                              { groupId: event.target.value || null },
                            ),
                          )
                        }
                      />
                    </>
                  )}
                  {business && isOwner && member.role !== 'OWNER' && (
                    <Button
                      variant="secondary"
                      busy={busy === `admin-${member.userId}`}
                      onClick={() =>
                        void run(`admin-${member.userId}`, () =>
                          apiRequest<MembersPage>(
                            'PATCH',
                            `organizations/${id}/members/${member.userId}`,
                            { admin: member.role !== 'ADMIN' },
                          ),
                        )
                      }
                    >
                      {member.role === 'ADMIN' ? t('list.unsetAdmin') : t('list.setAdmin')}
                    </Button>
                  )}
                  {canRemove && (
                    <Button variant="ghost" onClick={() => setRemoving(member)}>
                      {t('list.remove')}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </Panel>

      <ScopeGroupsDialog
        open={scoping !== null}
        name={scoping?.name ?? ''}
        groups={page.groups}
        initial={scoping?.scopeGroupIds ?? []}
        busy={busy === 'scopes'}
        onClose={() => setScoping(null)}
        onSave={(groupIds) =>
          void run('scopes', () =>
            apiRequest<MembersPage>('PATCH', `organizations/${id}/members/${scoping!.userId}`, {
              kind: 'SECRETARY',
              scopeGroupIds: groupIds,
            }),
          ).then((saved) => {
            if (saved) setScoping(null);
          })
        }
      />

      <Dialog
        open={removing !== null}
        title={t('remove.title', { name: removing?.name ?? '' })}
        closeLabel={tApp('close')}
        onClose={() => setRemoving(null)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setRemoving(null)}>
              {tApp('cancel')}
            </Button>
            <Button
              busy={busy === 'remove'}
              onClick={async () => {
                const member = removing!;
                const done = await run('remove', () =>
                  apiRequest<MembersPage>('DELETE', `organizations/${id}/members/${member.userId}`),
                );
                if (done) setRemoving(null);
              }}
            >
              {t('remove.confirm')}
            </Button>
          </>
        }
      >
        <p>{t('remove.text')}</p>
      </Dialog>
    </div>
  );
}
