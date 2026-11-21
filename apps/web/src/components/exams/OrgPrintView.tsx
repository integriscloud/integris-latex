'use client';

import type { OrgPrintOverview, OrgTemplateView } from '@integris/shared';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  FileDrop,
  Panel,
  TextAreaField,
  TextField,
} from '@integris/ui';
import { BadgeCheck, CircleCheck } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { apiRequest, apiUpload, type ClientError } from '../../lib/api-client';
import { formatBytes } from '../../lib/format';
import styles from './exams.module.css';
import { PrintJournal, useExamErrorMessage } from './print-shared';
import { PrintRequestRows } from './SecretariatQueueView';

/**
 * Print requests of the organization for its owner and admins (no mockup): what was sent, to
 * which class and in which status, and the whole access journal. Never the subject itself.
 */
export function OrgPrintView({ data }: { data: OrgPrintOverview }) {
  const t = useTranslations('OrgPrint');
  return (
    <div className={styles.stack}>
      <p className={styles.muted}>{t('help')}</p>
      <Panel title={t('requests', { count: data.requests.length })}>
        <PrintRequestRows requests={data.requests} emptyTitle={t('empty')} />
      </Panel>
      <Panel title={t('journal')}>
        <PrintJournal events={data.events} showRequest />
      </Panel>
    </div>
  );
}

/**
 * Official templates of a BUSINESS (no mockup): the owner and admins add a ZIP, publish it to
 * the members, unpublish, rename or delete it.
 */
export function OrgTemplatesView({
  organizationId,
  initial,
  maxArchiveBytes,
}: {
  organizationId: string;
  initial: OrgTemplateView[];
  maxArchiveBytes: number;
}) {
  const t = useTranslations('OrgTemplates');
  const locale = useLocale();
  const format = useFormatter();
  const errorMessage = useExamErrorMessage();
  const [templates, setTemplates] = useState(initial);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [archive, setArchive] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const [added, setAdded] = useState(false);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!archive || !name.trim()) return;
    if (archive.size > maxArchiveBytes) {
      setError({ code: 'archive_too_large' });
      return;
    }
    setBusy('add');
    setError(null);
    setAdded(false);
    const query = new URLSearchParams({ name: name.trim() });
    if (description.trim()) query.set('description', description.trim());
    const result = await apiUpload<OrgTemplateView[]>(
      'POST',
      `organizations/${organizationId}/templates?${query}`,
      archive,
      'application/zip',
      setProgress,
    );
    setBusy(null);
    setProgress(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setTemplates(result.data);
    setName('');
    setDescription('');
    setArchive(null);
    setAdded(true);
  };

  const change = async (key: string, method: 'PATCH' | 'DELETE', id: string, body: object = {}) => {
    setBusy(key);
    setError(null);
    const result = await apiRequest<OrgTemplateView[]>(
      method,
      `organizations/${organizationId}/templates/${encodeURIComponent(id)}`,
      body,
    );
    setBusy(null);
    if (!result.ok) setError(result.error);
    else setTemplates(result.data);
  };

  return (
    <div className={styles.stack}>
      <Panel title={t('add.title')}>
        <form className={styles.form} onSubmit={add}>
          <p className={styles.muted}>{t('add.help')}</p>
          <TextField
            label={t('add.name')}
            value={name}
            maxLength={120}
            required
            onChange={(event) => setName(event.target.value)}
          />
          <TextAreaField
            label={t('add.description')}
            value={description}
            maxLength={280}
            rows={2}
            onChange={(event) => setDescription(event.target.value)}
          />
          <FileDrop
            label={archive ? archive.name : t('add.choose')}
            hint={
              archive
                ? formatBytes(archive.size, locale)
                : t('add.hint', { size: formatBytes(maxArchiveBytes, locale) })
            }
            accept=".zip,application/zip"
            disabled={busy !== null}
            onFiles={(files) => setArchive(files[0] ?? null)}
          />
          {progress !== null && (
            <p className={styles.muted} aria-live="polite">
              {t('add.progress', { percent: Math.round(progress * 100) })}
            </p>
          )}
          {error && (
            <Alert tone="error">
              <p>{errorMessage(error)}</p>
            </Alert>
          )}
          {added && (
            <Alert tone="success">
              <p>{t('add.done')}</p>
            </Alert>
          )}
          <div className={styles.actions}>
            <Button type="submit" busy={busy === 'add'} disabled={!archive}>
              {t('add.submit')}
            </Button>
          </div>
        </form>
      </Panel>

      <Panel title={t('list.title', { count: templates.length })}>
        {templates.length ? (
          <ul className={styles.list}>
            {templates.map((template) => (
              <li key={template.id} className={styles.card}>
                <div className={styles.who}>
                  <div className={styles.badges}>
                    <p className={styles.name}>{template.name}</p>
                    {template.published ? (
                      <Badge tone="success" icon={CircleCheck}>
                        {t('list.published')}
                      </Badge>
                    ) : (
                      <Badge tone="neutral">{t('list.draft')}</Badge>
                    )}
                  </div>
                  {template.description && <p className={styles.muted}>{template.description}</p>}
                  <p className={styles.muted}>
                    {t('list.added', {
                      date: format.dateTime(new Date(template.createdAt), { dateStyle: 'medium' }),
                    })}
                  </p>
                </div>
                <div className={styles.actions}>
                  <Button
                    variant={template.published ? 'secondary' : 'primary'}
                    busy={busy === `publish-${template.id}`}
                    onClick={() =>
                      void change(`publish-${template.id}`, 'PATCH', template.id, {
                        published: !template.published,
                      })
                    }
                  >
                    {template.published ? t('list.unpublish') : t('list.publish')}
                  </Button>
                  <Button
                    variant="ghost"
                    busy={busy === `delete-${template.id}`}
                    onClick={() => void change(`delete-${template.id}`, 'DELETE', template.id)}
                  >
                    {t('list.delete')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={BadgeCheck} title={t('list.empty')} text={t('list.emptyHelp')} />
        )}
      </Panel>
    </div>
  );
}
