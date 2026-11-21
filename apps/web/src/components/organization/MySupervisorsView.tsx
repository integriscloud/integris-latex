'use client';

import type { MySupervisors } from '@integris/shared';
import { Alert, Badge, Button, IconButton, Panel, SelectField } from '@integris/ui';
import { X } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { apiRead, apiRequest, type ClientError } from '../../lib/api-client';
import styles from './org.module.css';
import { useOrgErrorMessage } from './use-org-error';

/**
 * A student's supervisors (BUSINESS): ask a teacher of the organization, and open the projects
 * of their choice to an active supervisor (Supervisor role, no invitation). The link alone opens
 * nothing; when it ends, the accesses it gave are removed.
 */
export function MySupervisorsView({
  organizationId,
  initial,
}: {
  organizationId: string;
  initial: MySupervisors;
}) {
  const t = useTranslations('MySupervisors');
  const format = useFormatter();
  const errorMessage = useOrgErrorMessage();
  const [data, setData] = useState(initial);
  const [teacherId, setTeacherId] = useState('');
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ClientError | null>(null);

  const reload = async () => {
    const result = await apiRead<MySupervisors>(`organizations/${organizationId}/my-supervisors`);
    if (result.ok) setData(result.data);
  };

  const run = async (key: string, call: () => Promise<{ ok: boolean; error?: ClientError }>) => {
    setBusy(key);
    setError(null);
    const result = await call();
    if (result.ok) await reload();
    else setError(result.error ?? null);
    setBusy(null);
    return result.ok;
  };

  const ask = async (event: FormEvent) => {
    event.preventDefault();
    const done = await run('ask', () =>
      apiRequest('POST', `organizations/${organizationId}/supervision-requests`, {
        supervisorId: teacherId,
      }),
    );
    if (done) setTeacherId('');
  };

  const linked = new Set(data.links.map((link) => link.supervisor.id));
  const teachers = data.teachers.filter((teacher) => !linked.has(teacher.id));

  return (
    <div className={styles.stack}>
      {error && (
        <Alert tone="error">
          <p>{errorMessage(error)}</p>
        </Alert>
      )}
      <Panel title={t('title', { count: data.links.length })}>
        {data.links.length === 0 && <p className={styles.muted}>{t('empty')}</p>}
        <ul className={styles.list}>
          {data.links.map((link) => {
            const opened = new Set(link.projects.map((project) => project.id));
            const available = data.projects.filter((project) => !opened.has(project.id));
            return (
              <li key={link.id} className={styles.item}>
                <div className={styles.who}>
                  <p className={styles.name}>{link.supervisor.name}</p>
                  <div className={styles.badges}>
                    {link.status === 'PENDING' ? (
                      <Badge tone="warning">{t('pending')}</Badge>
                    ) : (
                      <Badge tone="success">{t('active')}</Badge>
                    )}
                  </div>
                  {link.endsAt && (
                    <p className={styles.muted}>
                      {t('until', {
                        date: format.dateTime(new Date(link.endsAt), {
                          day: 'numeric',
                          month: 'long',
                          year: 'numeric',
                        }),
                      })}
                    </p>
                  )}
                  {link.status === 'ACTIVE' && (
                    <>
                      <p className={styles.muted}>
                        {link.projects.length ? t('opened') : t('noneOpened')}
                      </p>
                      <ul className={styles.projects}>
                        {link.projects.map((project) => (
                          <li key={project.id} className={styles.chip}>
                            {project.name}
                            <IconButton
                              icon={X}
                              label={t('close', { project: project.name })}
                              disabled={busy !== null}
                              onClick={() =>
                                void run(`close-${link.id}-${project.id}`, () =>
                                  apiRequest(
                                    'DELETE',
                                    `supervisions/${link.id}/projects/${project.id}`,
                                  ),
                                )
                              }
                            />
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
                <div className={styles.actions}>
                  {link.status === 'ACTIVE' && available.length > 0 && (
                    <>
                      <SelectField
                        label={t('project', { name: link.supervisor.name })}
                        options={[
                          { value: '', label: t('chooseProject') },
                          ...available.map((project) => ({
                            value: project.id,
                            label: project.name,
                          })),
                        ]}
                        value={choice[link.id] ?? ''}
                        onChange={(event) =>
                          setChoice((current) => ({ ...current, [link.id]: event.target.value }))
                        }
                      />
                      <Button
                        variant="secondary"
                        disabled={!choice[link.id]}
                        busy={busy === `open-${link.id}`}
                        onClick={async () => {
                          const done = await run(`open-${link.id}`, () =>
                            apiRequest('POST', `supervisions/${link.id}/projects`, {
                              projectId: choice[link.id],
                            }),
                          );
                          if (done) setChoice((current) => ({ ...current, [link.id]: '' }));
                        }}
                      >
                        {t('open')}
                      </Button>
                    </>
                  )}
                  {link.status === 'PENDING' && (
                    <Button
                      variant="ghost"
                      busy={busy === `cancel-${link.id}`}
                      onClick={() =>
                        void run(`cancel-${link.id}`, () =>
                          apiRequest('POST', `supervisions/${link.id}/cancel`),
                        )
                      }
                    >
                      {t('cancel')}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </Panel>
      <Panel title={t('ask.title')}>
        {teachers.length === 0 ? (
          <p className={styles.muted}>{t('ask.none')}</p>
        ) : (
          <form className={styles.form} onSubmit={ask}>
            <div className={styles.inline}>
              <SelectField
                label={t('ask.teacher')}
                options={[
                  { value: '', label: t('ask.choose') },
                  ...teachers.map((teacher) => ({ value: teacher.id, label: teacher.name })),
                ]}
                value={teacherId}
                required
                onChange={(event) => setTeacherId(event.target.value)}
              />
              <Button type="submit" busy={busy === 'ask'}>
                {t('ask.submit')}
              </Button>
            </div>
            <p className={styles.muted}>{t('ask.help')}</p>
          </form>
        )}
      </Panel>
    </div>
  );
}
