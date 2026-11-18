'use client';

import type {
  ImportResult,
  ProjectLimits,
  ProjectSummary,
  SkippedFile,
  TemplateSummary,
} from '@integris/shared';
import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  FileDrop,
  Panel,
  Tabs,
  TemplateCard,
  TextField,
} from '@integris/ui';
import { BadgeCheck, FileArchive, FilePlus, LayoutTemplate } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { getPathname, useRouter } from '../../i18n/navigation';
import { apiPost, apiUpload } from '../../lib/api-client';
import { formatBytes } from '../../lib/format';
import styles from './app.module.css';
import { useApiErrorMessage } from './use-api-error';

export type NewProjectTab = 'blank' | 'template' | 'zip';

export interface NewProjectProps {
  tab: NewProjectTab;
  templates: TemplateSummary[];
  limits: ProjectLimits;
}

/** "Nouveau projet": empty, from a template, or imported from a ZIP archive (no mockup yet). */
export function NewProject({ tab: initialTab, templates, limits }: NewProjectProps) {
  const t = useTranslations('NewProject');
  const locale = useLocale();
  const router = useRouter();
  const message = useApiErrorMessage(locale);
  const [tab, setTab] = useState<NewProjectTab>(initialTab);
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [archive, setArchive] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ImportResult | null>(null);

  const open = (id: string) => router.push(`/app/projects/${id}`);

  const chooseTemplate = (template: TemplateSummary) => {
    setTemplateId(template.id);
    if (!name.trim()) setName(template.name);
  };

  const chooseArchive = (files: File[]) => {
    const file = files[0]!;
    setError(null);
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setArchive(null);
      setError(t('zipOnly'));
      return;
    }
    if (file.size > limits.maxArchiveBytes) {
      setArchive(null);
      setError(message({ code: 'archive_too_large' }, limits));
      return;
    }
    setArchive(file);
    if (!name.trim()) setName(file.name.replace(/\.zip$/i, '').slice(0, 120));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    if (tab === 'zip') {
      if (!archive) {
        setBusy(false);
        setError(t('zipMissing'));
        return;
      }
      setProgress(0);
      const result = await apiUpload<ImportResult>(
        'POST',
        `projects/import?name=${encodeURIComponent(name.trim())}`,
        archive,
        'application/zip',
        setProgress,
      );
      setProgress(null);
      setBusy(false);
      if (!result.ok) {
        setError(message(result.error, limits));
        return;
      }
      if (result.data.skipped.length) setReport(result.data);
      else open(result.data.project.id);
      return;
    }
    const result = await apiPost<ProjectSummary>('projects', {
      name: name.trim(),
      ...(tab === 'template' && templateId ? { templateId } : {}),
    });
    setBusy(false);
    if (!result.ok) {
      setError(message(result.error, limits));
      return;
    }
    open(result.data.id);
  };

  if (report) {
    return (
      <Panel title={t('reportTitle')}>
        <Alert tone="success">{t('reportImported', { count: report.imported })}</Alert>
        <Alert tone="warning">
          {t('reportSkipped', { count: report.skippedCount })}
          <ul className={styles.report}>
            {report.skipped.map((file: SkippedFile) => (
              <li key={file.path}>
                <code>{file.path}</code> — {t(`skip.${file.reason}`)}
              </li>
            ))}
            {report.skippedCount > report.skipped.length && (
              <li>{t('reportMore', { count: report.skippedCount - report.skipped.length })}</li>
            )}
          </ul>
        </Alert>
        <div className={styles.row}>
          <ButtonLink href={getPathname({ href: `/app/projects/${report.project.id}`, locale })}>
            {t('openProject')}
          </ButtonLink>
        </div>
      </Panel>
    );
  }

  const canSubmit =
    Boolean(name.trim()) &&
    (tab === 'blank' || (tab === 'template' && templateId) || (tab === 'zip' && archive));

  return (
    <Panel>
      <Tabs
        label={t('tabsLabel')}
        idPrefix="new-project"
        value={tab}
        onChange={(id) => {
          setTab(id as NewProjectTab);
          setError(null);
        }}
        items={[
          { id: 'blank', label: t('tabs.blank'), icon: FilePlus },
          { id: 'template', label: t('tabs.template'), icon: LayoutTemplate },
          { id: 'zip', label: t('tabs.zip'), icon: FileArchive },
        ]}
      />
      <form
        className={styles.panelBody}
        role="tabpanel"
        id={`new-project-panel-${tab}`}
        aria-labelledby={`new-project-tab-${tab}`}
        onSubmit={submit}
      >
        <p className={styles.muted}>{t(`intro.${tab}`)}</p>

        {tab === 'template' &&
          (templates.length ? (
            <fieldset className={styles.templates}>
              <legend className={styles.legend}>{t('chooseTemplate')}</legend>
              {templates.map((template) => (
                <TemplateCard
                  key={template.id}
                  name="template"
                  value={template.id}
                  title={template.name}
                  description={template.description}
                  checked={templateId === template.id}
                  onChange={() => chooseTemplate(template)}
                  badge={
                    template.scope === 'ORGANIZATION' ? (
                      <Badge tone="accent" icon={BadgeCheck}>
                        {t('official', { organization: template.organizationName ?? '' })}
                      </Badge>
                    ) : undefined
                  }
                />
              ))}
            </fieldset>
          ) : (
            <p className={styles.muted}>{t('noTemplates')}</p>
          ))}

        {tab === 'zip' && (
          <div className={styles.stack}>
            <FileDrop
              label={archive ? archive.name : t('zipChoose')}
              hint={
                archive
                  ? formatBytes(archive.size, locale)
                  : t('zipHint', {
                      max: formatBytes(limits.maxArchiveBytes, locale),
                      maxFile: formatBytes(limits.maxFileBytes, locale),
                    })
              }
              accept=".zip,application/zip"
              disabled={busy}
              onFiles={chooseArchive}
            />
            <p className={styles.muted}>
              {t('zipTypes', { extensions: limits.extensions.join(' ') })}
            </p>
          </div>
        )}

        <TextField
          label={t('name')}
          value={name}
          maxLength={120}
          required
          onChange={(event) => setName(event.target.value)}
        />

        {error && <Alert tone="error">{error}</Alert>}
        {progress !== null && (
          <p className={styles.progress} role="status">
            {progress < 1
              ? t('uploading', { percent: Math.round(progress * 100) })
              : t('extracting')}
          </p>
        )}
        <div className={styles.row}>
          <Button type="submit" busy={busy} disabled={!canSubmit}>
            {busy ? t('creating') : tab === 'zip' ? t('submitZip') : t('submit')}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
