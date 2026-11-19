'use client';

import type { Compilation, CompileIssue } from '@integris/shared';
import { Alert, Badge, Button, Dialog, IssueCard } from '@integris/ui';
import { CircleCheck, FileText } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { loadLog } from '../../lib/compile/api';
import styles from './editor.module.css';

/** Issues shown in the panel (docs/spec.md: the first 1 to 3 errors). */
const SHOWN = 3;

/** Every value a message may use; a value missing from the log shows as an ellipsis. */
const ARG_NAMES = [
  'command',
  'file',
  'name',
  'begin',
  'beginLine',
  'end',
  'package',
  'option',
  'extension',
  'character',
  'code',
  'font',
  'language',
  'message',
  'class',
  'kind',
  'what',
  'label',
  'key',
  'module',
];

/** The issues to show: errors first, warnings only when there is no error. */
export function shownIssues(compilation: Compilation): CompileIssue[] {
  const errors = compilation.issues.filter((issue) => issue.severity === 'error');
  return (errors.length ? errors : compilation.issues).slice(0, SHOWN);
}

export interface CompileResultProps {
  projectId: string;
  compilation: Compilation;
  /** Opens a project file at a line; false when the file is not in the project. */
  onOpen: (path: string, line: number) => boolean;
}

/** Outcome of a compilation: a message, the counts, the first translated issues, the raw log. */
export function CompileResult({ projectId, compilation, onOpen }: CompileResultProps) {
  const t = useTranslations('Editor');
  const issueText = useTranslations('CompileIssues');
  const [log, setLog] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);

  const openLog = async () => {
    setLogOpen(true);
    setLog(null);
    const result = await loadLog(projectId, compilation.id);
    setLog(result.ok ? result.data : t('pdfViewer.failed'));
  };

  const { outcome } = compilation;
  const shown = shownIssues(compilation);
  const hidden = compilation.errorCount + compilation.warningCount - shown.length;
  const seconds = Math.round((compilation.durationMs ?? 0) / 100) / 10;

  const describe = (issue: CompileIssue): ReactNode => {
    const values: Record<string, string> = Object.fromEntries(ARG_NAMES.map((name) => [name, '…']));
    Object.assign(values, issue.args);
    return issueText.rich(`${issue.id}.text`, {
      ...values,
      code: (chunks) => <code>{chunks}</code>,
    });
  };

  return (
    <section className={styles.result} aria-label={t('issuesTitle')}>
      {outcome === 'success' ? (
        <p className={styles.success} role="status">
          <CircleCheck size={16} strokeWidth={1.75} aria-hidden="true" />
          {t('compileSucceeded', { seconds })}
        </p>
      ) : (
        outcome && (
          <Alert tone={outcome === 'tex_errors' ? 'warning' : 'error'}>
            {t(`outcome.${outcome}`, { seconds: compilation.maxSeconds })}
          </Alert>
        )
      )}
      <div className={styles.resultBar}>
        {compilation.errorCount > 0 && (
          <Badge tone="danger">{t('issuesErrors', { count: compilation.errorCount })}</Badge>
        )}
        {compilation.warningCount > 0 && (
          <Badge tone="warning">{t('issuesWarnings', { count: compilation.warningCount })}</Badge>
        )}
        {compilation.log && (
          <Button variant="secondary" onClick={() => void openLog()}>
            <FileText size={18} strokeWidth={1.75} aria-hidden="true" />
            {t('rawLog')}
          </Button>
        )}
      </div>
      {shown.map((issue, index) => (
        <IssueCard
          key={`${issue.id}-${index}`}
          severity={issue.severity}
          title={issueText(`${issue.id}.title`, {
            package: issue.args.package ?? '…',
            class: issue.args.class ?? '…',
            command: issue.args.command ?? '…',
          })}
          location={
            issue.file && issue.line
              ? {
                  label: t('issueLocation', { file: issue.file, line: issue.line }),
                  onOpen: () => onOpen(issue.file!, issue.line!),
                }
              : undefined
          }
        >
          {describe(issue)}
          {!issue.file && issue.line ? ` (${t('issueLine', { line: issue.line })})` : null}
        </IssueCard>
      ))}
      {hidden > 0 && <p className={styles.resultMore}>{t('issuesMore', { count: hidden })}</p>}
      <Dialog
        open={logOpen}
        title={t('rawLogTitle')}
        closeLabel={t('close')}
        onClose={() => setLogOpen(false)}
        actions={
          <Button variant="secondary" onClick={() => setLogOpen(false)}>
            {t('close')}
          </Button>
        }
      >
        {log === null ? (
          <p role="status">{t('rawLogLoading')}</p>
        ) : (
          <pre className={styles.log}>{log}</pre>
        )}
      </Dialog>
    </section>
  );
}
