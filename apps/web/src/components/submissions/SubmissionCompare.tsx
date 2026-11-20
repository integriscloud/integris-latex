'use client';

import type { FileComparison, SubmissionComparison, SubmissionDetail } from '@integris/shared';
import { Alert, Button, DiffView, EmptyState, PageHeader } from '@integris/ui';
import { ArrowLeft, GitCompare } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useState } from 'react';
import { getPathname } from '../../i18n/navigation';
import type { ClientError } from '../../lib/api-client';
import { compareSubmission } from '../../lib/submissions/api';
import appStyles from '../app/app.module.css';
import { useApiErrorMessage } from '../app/use-api-error';
import styles from './submissions.module.css';

/**
 * Comparison of two versions of a submission (docs/spec.md, "Comparaison"): line-by-line
 * differences of the files sent, by default the last version against the one before.
 */
export function SubmissionCompare({
  detail,
  from: initialFrom,
  to: initialTo,
}: {
  detail: SubmissionDetail;
  from: number;
  to: number;
}) {
  const t = useTranslations('Submissions');
  const locale = useLocale();
  const errorMessage = useApiErrorMessage(locale);
  const numbers = detail.versions
    .flatMap((version) => (version.state === 'READY' && version.number ? [version.number] : []))
    .sort((a, b) => a - b);
  const [choice, setChoice] = useState({ from: initialFrom, to: initialTo });
  const [shown, setShown] = useState({ from: initialFrom, to: initialTo });
  const [result, setResult] = useState<SubmissionComparison | null>(null);
  const [error, setError] = useState<ClientError | null>(null);

  const submissionHref = getPathname({
    href: `/app/projects/${detail.projectId}/submissions/${detail.id}`,
    locale,
  });
  const enough = numbers.length >= 2;

  useEffect(() => {
    if (!enough) return;
    let cancelled = false;
    void compareSubmission(detail.projectId, detail.id, shown.from, shown.to).then((answer) => {
      if (cancelled) return;
      if (answer.ok) {
        setResult(answer.data);
        setError(null);
      } else setError(answer.error);
    });
    return () => {
      cancelled = true;
    };
  }, [detail.projectId, detail.id, shown, enough]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setShown(choice);
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}?from=${choice.from}&to=${choice.to}`,
    );
  };

  const note = (file: FileComparison) => {
    if (file.change === 'same') return t('diffSame');
    if (file.kind === 'BINARY') return t('diffBinary');
    if (file.tooLarge) return t('diffTooLarge');
    return undefined;
  };

  const select = (key: 'from' | 'to', label: string) => (
    <label>
      <span className={styles.label}>{label}</span>
      <select
        className={styles.select}
        value={choice[key]}
        onChange={(event) => setChoice({ ...choice, [key]: Number(event.target.value) })}
      >
        {numbers.map((number) => (
          <option key={number} value={number}>
            {t('versionLong', { number })}
          </option>
        ))}
      </select>
    </label>
  );

  const changed = result?.files.filter((file) => file.change !== 'same') ?? [];

  return (
    <>
      <PageHeader
        back={
          <a className={appStyles.back} href={submissionHref}>
            <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
            {t('backToSubmission')}
          </a>
        }
        title={t('compareTitle')}
        subtitle={t('compareSubtitle', {
          title: detail.title ?? t('untitled'),
          from: shown.from,
          to: shown.to,
        })}
      />
      {!enough ? (
        <EmptyState icon={GitCompare} title={t('compareNeedTwo')} />
      ) : (
        <div className={styles.compare}>
          <form className={styles.compareForm} onSubmit={submit}>
            {select('from', t('compareFrom'))}
            {select('to', t('compareTo'))}
            <Button type="submit" variant="secondary">
              {t('compareShow')}
            </Button>
          </form>
          {error && <Alert tone="error">{errorMessage(error)}</Alert>}
          {!result && !error && (
            <p className={styles.meta} role="status">
              {t('loading')}
            </p>
          )}
          {result && changed.length === 0 && <Alert tone="info">{t('compareNothing')}</Alert>}
          {result?.files.map((file) => (
            <DiffView
              key={file.path}
              path={file.path}
              changeLabel={t(`change.${file.change}`)}
              hunks={file.hunks}
              added={file.added}
              removed={file.removed}
              note={note(file)}
              labels={{
                added: t('diffAdded'),
                removed: t('diffRemoved'),
                lines: t('diffLines'),
              }}
            />
          ))}
        </div>
      )}
    </>
  );
}
