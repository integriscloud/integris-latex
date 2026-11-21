'use client';

import { type ExamGroup, PRINT_LIMITS, type PrintRequestView } from '@integris/shared';
import { Alert, Button, Checkbox, SelectField, TextField } from '@integris/ui';
import { CircleCheck, EyeOff, Lock, ScrollText } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import type { ClientError } from '../../lib/api-client';
import { DueDateField, useDueInput } from '../submissions/DueDateField';
import styles from './exams.module.css';
import { useExamErrorMessage } from './print-shared';

/** What the form sends: a new request, or the changes of one not opened yet. */
export interface PrintFormValue {
  title: string;
  groupId: string;
  copies: number;
  reserveCopies: number;
  duplex: 'SIMPLEX' | 'DUPLEX';
  stapled: boolean;
  availableFrom: string;
  examAt: string;
}

const ICON = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const;

/**
 * "Envoyer au secrétariat" (mockup professeur-03, rebuilt): class, copies and reserve, format,
 * availability date and exam date, with the confidentiality rules. Also used to change a
 * request not opened yet (`initial`).
 */
export function PrintRequestForm({
  groups,
  defaultTitle,
  initial,
  submitLabel,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  groups: ExamGroup[];
  defaultTitle: string;
  initial?: PrintRequestView;
  submitLabel: string;
  busy: boolean;
  error: ClientError | null;
  onSubmit: (value: PrintFormValue) => void;
  onCancel?: () => void;
}) {
  const t = useTranslations('Exams.form');
  const tPrint = useTranslations('Print');
  const errorMessage = useExamErrorMessage();
  const [title, setTitle] = useState(initial?.title ?? defaultTitle);
  const [groupId, setGroupId] = useState(
    initial?.groupId ?? groups.find((group) => group.secretariats > 0)?.id ?? '',
  );
  const [copies, setCopies] = useState(String(initial?.copies ?? ''));
  const [reserve, setReserve] = useState(String(initial?.reserveCopies ?? 0));
  const [duplex, setDuplex] = useState<'SIMPLEX' | 'DUPLEX'>(initial?.duplex ?? 'DUPLEX');
  const [stapled, setStapled] = useState(initial?.stapled ?? true);
  const available = useDueInput(initial?.availableFrom ?? null);
  const exam = useDueInput(initial?.examAt ?? null);
  const [tried, setTried] = useState(false);

  const group = groups.find((item) => item.id === groupId);
  const availableAt = available.read();
  const examAt = exam.read();
  const copiesNumber = Number(copies);
  const reserveNumber = Number(reserve);
  const copiesValid =
    Number.isInteger(copiesNumber) && copiesNumber >= 1 && copiesNumber <= PRINT_LIMITS.copiesMax;
  const reserveValid =
    Number.isInteger(reserveNumber) &&
    reserveNumber >= 0 &&
    reserveNumber <= PRINT_LIMITS.reserveMax;
  const datesValid =
    typeof availableAt === 'string' &&
    availableAt !== 'invalid' &&
    typeof examAt === 'string' &&
    examAt !== 'invalid' &&
    availableAt < examAt;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (!title.trim() || !group || !copiesValid || !reserveValid || !datesValid) return;
    onSubmit({
      title: title.trim(),
      groupId,
      copies: copiesNumber,
      reserveCopies: reserveNumber,
      duplex,
      stapled,
      availableFrom: availableAt as string,
      examAt: examAt as string,
    });
  };

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <TextField
        label={t('title')}
        value={title}
        maxLength={PRINT_LIMITS.titleMax}
        required
        error={tried && !title.trim() ? t('required') : undefined}
        onChange={(event) => setTitle(event.target.value)}
      />
      {groups.length ? (
        <SelectField
          label={t('group')}
          value={groupId}
          options={[
            { value: '', label: t('chooseGroup') },
            ...groups.map((item) => ({
              value: item.id,
              label:
                item.secretariats > 0
                  ? item.name
                  : t('groupWithoutSecretariat', { name: item.name }),
            })),
          ]}
          error={
            tried && !group
              ? t('required')
              : group && !group.secretariats
                ? t('noSecretariat')
                : undefined
          }
          onChange={(event) => setGroupId(event.target.value)}
        />
      ) : (
        <Alert tone="info">
          <p>{t('noGroups')}</p>
        </Alert>
      )}
      <div className={styles.inline}>
        <TextField
          label={t('copies')}
          inputMode="numeric"
          value={copies}
          required
          error={
            tried && !copiesValid ? t('copiesInvalid', { max: PRINT_LIMITS.copiesMax }) : undefined
          }
          onChange={(event) => setCopies(event.target.value)}
        />
        <TextField
          label={t('reserve')}
          inputMode="numeric"
          value={reserve}
          error={
            tried && !reserveValid
              ? t('reserveInvalid', { max: PRINT_LIMITS.reserveMax })
              : undefined
          }
          onChange={(event) => setReserve(event.target.value)}
        />
      </div>
      <div className={styles.inline}>
        <SelectField
          label={t('duplex')}
          value={duplex}
          options={[
            { value: 'DUPLEX', label: tPrint('duplex.DUPLEX') },
            { value: 'SIMPLEX', label: tPrint('duplex.SIMPLEX') },
          ]}
          onChange={(event) => setDuplex(event.target.value as 'SIMPLEX' | 'DUPLEX')}
        />
        <div className={styles.fieldset}>
          <Checkbox checked={stapled} onChange={(event) => setStapled(event.target.checked)}>
            {tPrint('stapled')}
          </Checkbox>
        </div>
      </div>
      <DueDateField
        legend={t('availableFrom')}
        value={available.input}
        onChange={available.setInput}
        invalid={tried && (availableAt === 'invalid' || availableAt === null)}
      />
      <DueDateField
        legend={t('examAt')}
        value={exam.input}
        onChange={exam.setInput}
        invalid={tried && (examAt === 'invalid' || examAt === null)}
      />
      {tried &&
        availableAt &&
        examAt &&
        availableAt !== 'invalid' &&
        examAt !== 'invalid' &&
        !datesValid && (
          <Alert tone="error">
            <p>{t('datesOrder')}</p>
          </Alert>
        )}
      <section className={styles.confidential} aria-labelledby="exam-confidential">
        <h3 id="exam-confidential">{t('confidential.title')}</h3>
        <ul>
          <li>
            <Lock {...ICON} />
            <span>{t('confidential.locked')}</span>
          </li>
          <li>
            <ScrollText {...ICON} />
            <span>{t('confidential.journal')}</span>
          </li>
          <li>
            <EyeOff {...ICON} />
            <span>{t('confidential.private')}</span>
          </li>
          <li>
            <CircleCheck {...ICON} />
            <span>{t('confidential.frozen')}</span>
          </li>
        </ul>
      </section>
      {error && (
        <Alert tone="error">
          <p>{errorMessage(error)}</p>
        </Alert>
      )}
      <div className={styles.actions}>
        <Button type="submit" busy={busy} disabled={!groups.length}>
          {submitLabel}
        </Button>
        {onCancel && (
          <Button variant="secondary" onClick={onCancel}>
            {t('back')}
          </Button>
        )}
      </div>
    </form>
  );
}
