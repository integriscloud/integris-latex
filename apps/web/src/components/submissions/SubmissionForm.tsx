'use client';

import {
  SUBMISSION_MESSAGE_MAX,
  SUBMISSION_TITLE_MAX,
  type SubmissionList,
} from '@integris/shared';
import { Alert, Badge, Button, Checkbox, TextAreaField, TextField } from '@integris/ui';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { DueDateField, useDueInput } from './DueDateField';
import styles from './submissions.module.css';

export interface SubmissionValues {
  title: string | null;
  filePaths: string[];
  message: string | null;
  dueAt: string | null;
  reviewerIds: string[];
}

export interface SubmissionFormProps {
  /** `draft`: everything of a draft; `send`: the files and message of a sending. */
  mode: 'draft' | 'send';
  initial: SubmissionValues;
  /** Paths of the project files. */
  paths: string[];
  candidates: SubmissionList['candidates'];
  heading: string;
  help?: string;
  submitLabel: string;
  /** Resolves to an error message, or null on success. */
  onSubmit: (values: SubmissionValues) => Promise<string | null>;
  onCancel: () => void;
}

/** Draft of a submission (title, files, message, deadline, reviewers), or a sending. */
export function SubmissionForm({
  mode,
  initial,
  paths,
  candidates,
  heading,
  help,
  submitLabel,
  onSubmit,
  onCancel,
}: SubmissionFormProps) {
  const t = useTranslations('Submissions');
  const [title, setTitle] = useState(initial.title ?? '');
  const [files, setFiles] = useState(() => new Set(initial.filePaths));
  const [message, setMessage] = useState(initial.message ?? '');
  const due = useDueInput(initial.dueAt);
  const [dueInvalid, setDueInvalid] = useState(false);
  const [reviewers, setReviewers] = useState(() => new Set(initial.reviewerIds));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (set: Set<string>, value: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(value);
    else next.delete(value);
    return next;
  };

  const sending = mode === 'send';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const dueAt = sending ? initial.dueAt : due.read();
    setDueInvalid(dueAt === 'invalid');
    if (dueAt === 'invalid') return;
    setBusy(true);
    const result = await onSubmit({
      title: title.trim() || null,
      // In the order of the project.
      filePaths: paths.filter((path) => files.has(path)),
      message: message.trim() || null,
      dueAt,
      reviewerIds: [...reviewers],
    });
    setBusy(false);
    setError(result);
  };

  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)}>
      <h3 className={styles.heading}>{heading}</h3>
      {help && <p className={styles.help}>{help}</p>}
      {error && <Alert tone="error">{error}</Alert>}
      {!sending && (
        <TextField
          label={t('form.title')}
          optionalLabel={t('form.optional')}
          help={t('form.titleHelp')}
          value={title}
          maxLength={SUBMISSION_TITLE_MAX}
          onChange={(event) => setTitle(event.target.value)}
        />
      )}
      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t('form.files')}</legend>
        <p className={styles.help}>{t('form.filesHelp')}</p>
        <ul className={styles.choices}>
          {paths.map((path) => (
            <li key={path}>
              <label className={styles.fileChoice} title={path}>
                <input
                  type="checkbox"
                  className={styles.fileBox}
                  checked={files.has(path)}
                  onChange={(event) => setFiles(toggle(files, path, event.target.checked))}
                />
                <span className={styles.filePath}>{path}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <TextAreaField
        label={t('form.message')}
        optionalLabel={t('form.optional')}
        help={t('form.messageHelp')}
        value={message}
        rows={3}
        maxLength={SUBMISSION_MESSAGE_MAX}
        onChange={(event) => setMessage(event.target.value)}
      />
      {!sending && (
        <>
          <DueDateField
            legend={t('form.due')}
            optionalLabel={t('form.optional')}
            value={due.input}
            onChange={(value) => {
              due.setInput(value);
              setDueInvalid(false);
            }}
            invalid={dueInvalid}
          />
          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>{t('form.reviewers')}</legend>
            <p className={styles.help}>
              {candidates.length ? t('form.reviewersHelp') : t('form.noCandidates')}
            </p>
            {candidates.map((candidate) => (
              <Checkbox
                key={candidate.id}
                checked={reviewers.has(candidate.id)}
                onChange={(event) =>
                  setReviewers(toggle(reviewers, candidate.id, event.target.checked))
                }
              >
                <span className={styles.row}>
                  {candidate.name}
                  <Badge tone={candidate.role === 'SUPERVISOR' ? 'accent' : 'neutral'}>
                    {t(`form.role.${candidate.role}`)}
                  </Badge>
                </span>
              </Checkbox>
            ))}
          </fieldset>
        </>
      )}
      <div className={styles.actions}>
        <Button type="submit" busy={busy} disabled={sending && files.size === 0}>
          {submitLabel}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('form.cancel')}
        </Button>
      </div>
    </form>
  );
}
