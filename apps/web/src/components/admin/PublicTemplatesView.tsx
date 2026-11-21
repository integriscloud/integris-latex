'use client';

import { type AdminTemplate, PUBLIC_TEMPLATE_CATEGORIES } from '@integris/shared';
import {
  Alert,
  Badge,
  Button,
  FileDrop,
  Panel,
  SelectField,
  TextAreaField,
  TextField,
} from '@integris/ui';
import { CircleCheck } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { apiRequest, apiUpload, type ClientError } from '../../lib/api-client';
import { formatBytes } from '../../lib/format';
import { useAdminAction } from './admin-actions';
import styles from './admin.module.css';
import { useAdminErrorMessage } from './use-admin-error';

/**
 * Public templates published by Integris: a ZIP (same checks as a project import), a draft until
 * it is published; deleting one never touches the projects created from it.
 */
export function PublicTemplatesView({ initial }: { initial: AdminTemplate[] }) {
  const t = useTranslations('Admin.templates');
  const locale = useLocale();
  const format = useFormatter();
  const run = useAdminAction();
  const errorMessage = useAdminErrorMessage();
  const [templates, setTemplates] = useState(initial);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<string>(PUBLIC_TEMPLATE_CATEGORIES[0]);
  const [institution, setInstitution] = useState('');
  const [archive, setArchive] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const [added, setAdded] = useState(false);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!archive) return;
    setBusy('add');
    setError(null);
    setAdded(false);
    const query = new URLSearchParams({ name: name.trim(), category });
    if (description.trim()) query.set('description', description.trim());
    if (institution.trim()) query.set('institution', institution.trim());
    const result = await run(() =>
      apiUpload<AdminTemplate[]>(
        'POST',
        `admin/templates?${query}`,
        archive,
        'application/zip',
        setProgress,
      ),
    );
    setBusy(null);
    setProgress(null);
    if (!result.ok) return setError(result.error);
    setTemplates(result.data);
    setName('');
    setDescription('');
    setInstitution('');
    setArchive(null);
    setAdded(true);
  };

  const change = async (id: string, method: 'PATCH' | 'DELETE', body: object = {}) => {
    setBusy(id);
    setError(null);
    const result = await run(() =>
      apiRequest<AdminTemplate[]>(method, `admin/templates/${encodeURIComponent(id)}`, body),
    );
    setBusy(null);
    if (!result.ok) return setError(result.error);
    setTemplates(result.data);
  };

  return (
    <div className={styles.stack}>
      <Panel title={t('addTitle')}>
        <form className={styles.form} onSubmit={add}>
          <div className={styles.fields}>
            <TextField
              label={t('name')}
              value={name}
              maxLength={120}
              required
              onChange={(event) => setName(event.target.value)}
            />
            <SelectField
              label={t('category')}
              value={category}
              options={PUBLIC_TEMPLATE_CATEGORIES.map((value) => ({
                value,
                label: t(`categories.${value}`),
              }))}
              onChange={(event) => setCategory(event.target.value)}
            />
            <TextField
              label={t('institution')}
              help={t('optionalHelp')}
              value={institution}
              maxLength={120}
              onChange={(event) => setInstitution(event.target.value)}
            />
          </div>
          <TextAreaField
            label={t('description')}
            value={description}
            maxLength={280}
            rows={2}
            onChange={(event) => setDescription(event.target.value)}
          />
          <FileDrop
            label={archive ? archive.name : t('choose')}
            hint={archive ? formatBytes(archive.size, locale) : t('hint')}
            accept=".zip,application/zip"
            disabled={busy !== null}
            onFiles={(files) => setArchive(files[0] ?? null)}
          />
          {progress !== null && (
            <p className={styles.muted} aria-live="polite">
              {t('progress', { percent: Math.round(progress * 100) })}
            </p>
          )}
          {error && (
            <Alert tone="error">
              <p>{errorMessage(error)}</p>
            </Alert>
          )}
          {added && (
            <Alert tone="success">
              <p>{t('added')}</p>
            </Alert>
          )}
          <div className={styles.actions}>
            <Button type="submit" busy={busy === 'add'} disabled={!archive}>
              {t('add')}
            </Button>
          </div>
        </form>
      </Panel>
      <Panel title={t('listTitle', { count: templates.length })}>
        {templates.length ? (
          <ul className={styles.list}>
            {templates.map((template) => (
              <li key={template.id} className={styles.card}>
                <div className={styles.cardBody}>
                  <div className={styles.badges}>
                    <p className={styles.name}>{template.name}</p>
                    {template.published ? (
                      <Badge tone="success" icon={CircleCheck}>
                        {t('published')}
                      </Badge>
                    ) : (
                      <Badge tone="neutral">{t('draft')}</Badge>
                    )}
                  </div>
                  <p className={styles.muted}>
                    {t('summary', {
                      category: (PUBLIC_TEMPLATE_CATEGORIES as readonly string[]).includes(
                        template.category,
                      )
                        ? t(`categories.${template.category as 'autre'}`)
                        : template.category,
                      projects: template.projects,
                      date: format.dateTime(new Date(template.createdAt), { dateStyle: 'medium' }),
                    })}
                  </p>
                  {template.description && <p className={styles.muted}>{template.description}</p>}
                </div>
                <div className={styles.actions}>
                  <Button
                    variant="secondary"
                    busy={busy === template.id}
                    onClick={() =>
                      void change(template.id, 'PATCH', { published: !template.published })
                    }
                  >
                    {template.published ? t('unpublish') : t('publish')}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => {
                      if (window.confirm(t('confirmDelete', { name: template.name }))) {
                        void change(template.id, 'DELETE');
                      }
                    }}
                  >
                    {t('delete')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.muted}>{t('none')}</p>
        )}
      </Panel>
    </div>
  );
}
