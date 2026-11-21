'use client';

import type { SupervisionAdmin, SupervisionLink } from '@integris/shared';
import { Alert, Badge, Button, Dialog, Panel, SelectField, TextField } from '@integris/ui';
import { useFormatter, useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { apiRequest, type ClientError } from '../../lib/api-client';
import { endOfDayIso, todayIso } from './dates';
import styles from './org.module.css';
import { useOrgErrorMessage } from './use-org-error';

/**
 * Supervision of a BUSINESS for admins: assign a supervisor to a student (active at once), set
 * the day the link ends, reassign (the former supervisor loses the projects opened to them,
 * their comments stay) or end it. At most the plan's limit of students per supervisor.
 */
export function SupervisionAdminView({
  organizationId,
  initial,
}: {
  organizationId: string;
  initial: SupervisionAdmin;
}) {
  const t = useTranslations('SupervisionAdmin');
  const tApp = useTranslations('App');
  const format = useFormatter();
  const errorMessage = useOrgErrorMessage();
  const [data, setData] = useState(initial);
  const [supervisorId, setSupervisorId] = useState('');
  const [studentId, setStudentId] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const [editing, setEditing] = useState<{
    link: SupervisionLink;
    mode: 'reassign' | 'date';
  } | null>(null);
  const [editValue, setEditValue] = useState('');

  const base = `organizations/${organizationId}/supervisions`;
  const call = async (key: string, method: 'POST' | 'PATCH', path: string, body?: object) => {
    setBusy(key);
    setError(null);
    const result = await apiRequest<SupervisionAdmin>(method, path, body);
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    setData(result.data);
    return true;
  };

  const groupName = (groupId: string | null) =>
    data.groups.find((group) => group.id === groupId)?.name ?? null;
  const teacherOptions = [
    { value: '', label: t('choose') },
    ...data.teachers.map((teacher) => ({
      value: teacher.id,
      label: data.maxStudents
        ? t('teacherWithCount', {
            name: teacher.name,
            count: teacher.students,
            max: data.maxStudents,
          })
        : teacher.name,
    })),
  ];
  const studentOptions = [
    { value: '', label: t('choose') },
    ...data.students.map((student) => ({
      value: student.id,
      label: [student.name, groupName(student.groupId)].filter(Boolean).join(' · '),
    })),
  ];
  const date = (iso: string) =>
    format.dateTime(new Date(iso), { day: 'numeric', month: 'long', year: 'numeric' });

  const assign = async (event: FormEvent) => {
    event.preventDefault();
    const done = await call('assign', 'POST', base, {
      supervisorId,
      studentId,
      endsAt: endsAt ? endOfDayIso(endsAt) : null,
    });
    if (done) {
      setStudentId('');
      setEndsAt('');
    }
  };

  return (
    <div className={styles.stack}>
      {error && (
        <Alert tone="error">
          <p>{errorMessage(error)}</p>
        </Alert>
      )}
      <Panel title={t('assign.title')}>
        <form className={styles.form} onSubmit={assign}>
          <div className={styles.inline}>
            <SelectField
              label={t('assign.supervisor')}
              options={teacherOptions}
              value={supervisorId}
              required
              onChange={(event) => setSupervisorId(event.target.value)}
            />
            <SelectField
              label={t('assign.student')}
              options={studentOptions}
              value={studentId}
              required
              onChange={(event) => setStudentId(event.target.value)}
            />
            <TextField
              label={t('assign.endsAt')}
              optionalLabel={t('optional')}
              type="date"
              min={todayIso()}
              value={endsAt}
              onChange={(event) => setEndsAt(event.target.value)}
            />
          </div>
          <p className={styles.muted}>{t('assign.help')}</p>
          <div className={styles.actions}>
            <Button type="submit" busy={busy === 'assign'}>
              {t('assign.submit')}
            </Button>
          </div>
        </form>
      </Panel>
      <Panel title={t('links.title', { count: data.links.length })}>
        {data.links.length === 0 && <p className={styles.muted}>{t('links.empty')}</p>}
        <ul className={styles.list}>
          {data.links.map((link) => (
            <li key={link.id} className={styles.item}>
              <div className={styles.who}>
                <p className={styles.name}>
                  {t('links.pair', {
                    supervisor: link.supervisor.name,
                    student: link.student.name,
                  })}
                </p>
                <div className={styles.badges}>
                  {link.status === 'PENDING' && <Badge tone="warning">{t('links.pending')}</Badge>}
                  {groupName(link.student.groupId) && (
                    <Badge tone="neutral">{groupName(link.student.groupId)}</Badge>
                  )}
                </div>
                <p className={styles.muted}>
                  {link.endsAt
                    ? t('links.until', { date: date(link.endsAt) })
                    : t('links.since', { date: date(link.startsAt) })}
                </p>
              </div>
              <div className={styles.actions}>
                {link.status === 'ACTIVE' && (
                  <>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setEditing({ link, mode: 'reassign' });
                        setEditValue('');
                      }}
                    >
                      {t('links.reassign')}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setEditing({ link, mode: 'date' });
                        setEditValue(link.endsAt ? link.endsAt.slice(0, 10) : '');
                      }}
                    >
                      {t('links.setDate')}
                    </Button>
                  </>
                )}
                {link.status === 'PENDING' && (
                  <Button
                    variant="secondary"
                    busy={busy === `accept-${link.id}`}
                    onClick={() =>
                      void call(`accept-${link.id}`, 'POST', base, {
                        supervisorId: link.supervisor.id,
                        studentId: link.student.id,
                      })
                    }
                  >
                    {t('links.confirm')}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  busy={busy === `end-${link.id}`}
                  onClick={() => void call(`end-${link.id}`, 'POST', `${base}/${link.id}/end`)}
                >
                  {t('links.end')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Panel>
      <Dialog
        open={editing !== null}
        title={
          editing?.mode === 'reassign'
            ? t('reassign.title', { name: editing.link.student.name })
            : t('date.title', { name: editing?.link.student.name ?? '' })
        }
        closeLabel={tApp('close')}
        onClose={() => setEditing(null)}
        onSubmit={async () => {
          const { link, mode } = editing!;
          const done =
            mode === 'reassign'
              ? await call('edit', 'POST', `${base}/${link.id}/reassign`, {
                  supervisorId: editValue,
                })
              : await call('edit', 'PATCH', `${base}/${link.id}`, {
                  endsAt: editValue ? endOfDayIso(editValue) : null,
                });
          if (done) setEditing(null);
        }}
        actions={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              {tApp('cancel')}
            </Button>
            <Button type="submit" busy={busy === 'edit'}>
              {t('save')}
            </Button>
          </>
        }
      >
        {editing?.mode === 'reassign' ? (
          <>
            <SelectField
              label={t('reassign.to')}
              options={teacherOptions.filter(
                (option) => option.value !== editing.link.supervisor.id,
              )}
              value={editValue}
              required
              onChange={(event) => setEditValue(event.target.value)}
            />
            <p className={styles.muted}>{t('reassign.help')}</p>
          </>
        ) : (
          <TextField
            label={t('assign.endsAt')}
            optionalLabel={t('optional')}
            type="date"
            min={todayIso()}
            value={editValue}
            onChange={(event) => setEditValue(event.target.value)}
          />
        )}
      </Dialog>
    </div>
  );
}
