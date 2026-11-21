'use client';

import type { AdminPlan, PlanRevisionView, PlanTerms } from '@integris/shared';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Panel,
  SelectField,
  TextAreaField,
  TextField,
} from '@integris/ui';
import { useFormatter, useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { apiRead, apiRequest, type ClientError } from '../../lib/api-client';
import { useAdminAction } from './admin-actions';
import styles from './admin.module.css';
import { useAdminErrorMessage } from './use-admin-error';

const MIB = 1024 * 1024;

type NumberTerm = Exclude<
  keyof PlanTerms,
  'nameFr' | 'nameEn' | 'autoCompile' | 'supervisionDashboard' | 'compilePriority'
>;

/** Number fields: prices (new paid periods only), then quotas; `nullable`: empty = unlimited. */
const PRICE_FIELDS: { key: NumberTerm; nullable?: boolean }[] = [
  { key: 'priceMonthlyXof' },
  { key: 'priceYearlyXof' },
  { key: 'minSeats' },
  { key: 'maxSeats', nullable: true },
  { key: 'trialDays', nullable: true },
];
const QUOTA_FIELDS: { key: NumberTerm; nullable?: boolean }[] = [
  { key: 'maxProjects', nullable: true },
  { key: 'maxCollaboratorsPerProject', nullable: true },
  { key: 'maxCompileSeconds' },
  { key: 'maxCompilesPerHour' },
  { key: 'storageBytes' },
  { key: 'historyDays', nullable: true },
  { key: 'maxSupervisedStudents', nullable: true },
  { key: 'maxAdmins' },
  { key: 'aiRequestsPerDay' },
];

type Draft = Record<NumberTerm, string>;

const draftOf = (terms: PlanTerms): Draft =>
  Object.fromEntries(
    [...PRICE_FIELDS, ...QUOTA_FIELDS].map(({ key }) => {
      const value = terms[key];
      if (value === null) return [key, ''];
      return [key, String(key === 'storageBytes' ? Math.round(value / MIB) : value)];
    }),
  ) as Draft;

function PlanEditor({ plan, onSaved }: { plan: AdminPlan; onSaved: (plan: AdminPlan) => void }) {
  const t = useTranslations('Admin.plans');
  const format = useFormatter();
  const run = useAdminAction();
  const errorMessage = useAdminErrorMessage();
  const [names, setNames] = useState({ nameFr: plan.terms.nameFr, nameEn: plan.terms.nameEn });
  const [draft, setDraft] = useState<Draft>(() => draftOf(plan.terms));
  const [flags, setFlags] = useState({
    autoCompile: plan.terms.autoCompile,
    supervisionDashboard: plan.terms.supervisionDashboard,
    compilePriority: plan.terms.compilePriority,
  });
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  const [saved, setSaved] = useState(false);
  const [history, setHistory] = useState<PlanRevisionView[] | null>(null);

  const field = ({ key, nullable }: { key: NumberTerm; nullable?: boolean }) => (
    <TextField
      key={key}
      label={t(`fields.${key}`)}
      help={nullable ? t('unlimitedHelp') : undefined}
      inputMode="numeric"
      pattern="[0-9]*"
      value={draft[key]}
      required={!nullable}
      onChange={(event) => setDraft({ ...draft, [key]: event.target.value.trim() })}
    />
  );

  const terms = (): PlanTerms | null => {
    const values: Record<string, number | null> = {};
    for (const { key, nullable } of [...PRICE_FIELDS, ...QUOTA_FIELDS]) {
      const text = draft[key];
      if (text === '' && nullable) {
        values[key] = null;
        continue;
      }
      if (!/^\d+$/.test(text)) return null;
      values[key] = key === 'storageBytes' ? Number(text) * MIB : Number(text);
    }
    return { ...names, ...flags, ...(values as Record<NumberTerm, number>) } as PlanTerms;
  };

  const loadHistory = async () => {
    const result = await apiRead<PlanRevisionView[]>(`admin/plans/${plan.code}/revisions`);
    if (result.ok) setHistory(result.data);
    else setError(result.error);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaved(false);
    const next = terms();
    if (!next) return setError({ code: 'plan_terms_invalid' });
    setBusy(true);
    const result = await run(() =>
      apiRequest<PlanRevisionView[]>('PUT', `admin/plans/${plan.code}`, { terms: next, reason }),
    );
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setHistory(result.data);
    setReason('');
    setSaved(true);
    onSaved({ ...plan, terms: next, version: result.data[0]?.version ?? plan.version });
  };

  return (
    <Panel
      title={t('planTitle', { name: plan.terms.nameFr, code: plan.code })}
      actions={
        <div className={styles.badges}>
          <Badge tone="info">{t('version', { version: plan.version })}</Badge>
          <Badge tone="neutral">{t('live', { count: plan.liveSubscriptions })}</Badge>
        </div>
      }
    >
      <form className={styles.form} onSubmit={save}>
        <div className={styles.fields}>
          <TextField
            label={t('fields.nameFr')}
            value={names.nameFr}
            maxLength={40}
            required
            onChange={(event) => setNames({ ...names, nameFr: event.target.value })}
          />
          <TextField
            label={t('fields.nameEn')}
            value={names.nameEn}
            maxLength={40}
            required
            onChange={(event) => setNames({ ...names, nameEn: event.target.value })}
          />
        </div>
        <h3 className={styles.legend}>{t('pricesTitle')}</h3>
        <p className={styles.muted}>{t('pricesHelp')}</p>
        <div className={styles.fields}>{PRICE_FIELDS.map(field)}</div>
        <h3 className={styles.legend}>{t('quotasTitle')}</h3>
        <p className={styles.muted}>{t('quotasHelp')}</p>
        <div className={styles.fields}>
          {QUOTA_FIELDS.map(field)}
          <SelectField
            label={t('fields.compilePriority')}
            value={flags.compilePriority}
            options={(['HIGH', 'NORMAL', 'LOW'] as const).map((value) => ({
              value,
              label: t(`priority.${value}`),
            }))}
            onChange={(event) =>
              setFlags({
                ...flags,
                compilePriority: event.target.value as PlanTerms['compilePriority'],
              })
            }
          />
        </div>
        <div className={styles.checks}>
          <Checkbox
            checked={flags.autoCompile}
            onChange={(event) => setFlags({ ...flags, autoCompile: event.target.checked })}
          >
            {t('fields.autoCompile')}
          </Checkbox>
          <Checkbox
            checked={flags.supervisionDashboard}
            onChange={(event) => setFlags({ ...flags, supervisionDashboard: event.target.checked })}
          >
            {t('fields.supervisionDashboard')}
          </Checkbox>
        </div>
        <TextAreaField
          label={t('reason')}
          help={t('reasonHelp')}
          value={reason}
          minLength={3}
          maxLength={500}
          rows={2}
          required
          onChange={(event) => setReason(event.target.value)}
        />
        {error && (
          <Alert tone="error">
            <p>{errorMessage(error)}</p>
          </Alert>
        )}
        {saved && (
          <Alert tone="success">
            <p>{t('saved')}</p>
          </Alert>
        )}
        <div className={styles.actions}>
          <Button type="submit" busy={busy}>
            {t('save')}
          </Button>
          {history === null && (
            <Button type="button" variant="ghost" onClick={loadHistory}>
              {t('showHistory')}
            </Button>
          )}
        </div>
      </form>
      {history && (
        <section aria-label={t('historyTitle')}>
          <h3 className={styles.legend}>{t('historyTitle')}</h3>
          <ul className={styles.history}>
            {history.map((revision) => (
              <li key={revision.version}>
                <p className={styles.name}>
                  {t('revision', {
                    version: revision.version,
                    date: format.dateTime(new Date(revision.createdAt), {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }),
                    who: revision.changedBy ?? t('system'),
                  })}
                </p>
                <p className={styles.muted}>{revision.reason}</p>
                {revision.changed.length > 0 && (
                  <p className={styles.muted}>
                    {t('changed', {
                      fields: revision.changed
                        .map((key) => t(`fields.${key as NumberTerm}`))
                        .join(', '),
                    })}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </Panel>
  );
}

/** Plans, prices and quotas (docs/spec.md, "décisions étape 14"). */
export function PlansView({ initial }: { initial: AdminPlan[] }) {
  const [plans, setPlans] = useState(initial);
  return (
    <div className={styles.stack}>
      {plans.map((plan) => (
        <PlanEditor
          key={plan.code}
          plan={plan}
          onSaved={(next) =>
            setPlans((list) => list.map((item) => (item.code === next.code ? next : item)))
          }
        />
      ))}
    </div>
  );
}
