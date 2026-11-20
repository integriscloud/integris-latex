'use client';

import type { AccountUsage, UsageMeter } from '@integris/shared';
import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  Panel,
  ProjectList as List,
  ProjectRow,
  UsageSummary,
} from '@integris/ui';
import { CircleCheck, Lock } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { getPathname, useRouter } from '../../i18n/navigation';
import { durationParts, formatBytes } from '../../lib/format';
import styles from './app.module.css';
import { MakeWritableDialog } from './MakeWritableDialog';

type Meter = 'projects' | 'storage' | 'compilesPerHour';

/**
 * "Ma consommation" (screen without mockup): the effective plan and where its quotas come from,
 * each quota of the grid with its usage, the counters of the month, and the owned projects,
 * writable or read-only beyond the plan's limit.
 */
export function UsageView({ usage }: { usage: AccountUsage }) {
  const t = useTranslations('Usage');
  const locale = useLocale();
  const format = useFormatter();
  const router = useRouter();
  const [writable, setWritable] = useState<{ id: string; name: string } | null>(null);
  const name = (value: { fr: string; en: string }) => (locale === 'fr' ? value.fr : value.en);
  const pricing = `${getPathname({ href: '/', locale })}#pricing`;
  const date = (value: string) => format.dateTime(new Date(value), { dateStyle: 'medium' });

  const meterValue = (meter: Meter, value: UsageMeter) => {
    if (meter === 'storage') {
      return t('of', {
        used: formatBytes(value.used, locale),
        max: formatBytes(value.max ?? 0, locale),
      });
    }
    return value.max === null
      ? t('unlimitedCount', { count: value.used })
      : t('of', { used: value.used, max: value.max });
  };

  const meters: [Meter, UsageMeter][] = [
    ['projects', usage.projects],
    ['storage', usage.storage],
    ['compilesPerHour', usage.compilesPerHour],
  ];
  const alerts = meters.flatMap(([meter, value]) =>
    value.level === 'ok' ? [] : [{ meter, level: value.level }],
  );
  const { limits } = usage;
  const duration = durationParts(usage.month.compileSeconds);
  const compileTime =
    duration.unit === 'seconds'
      ? t('duration.seconds', { seconds: duration.seconds })
      : duration.unit === 'minutes'
        ? duration.seconds
          ? t('duration.minutesSeconds', duration)
          : t('duration.minutes', duration)
        : t('duration.hours', duration);

  return (
    <div className={styles.stack}>
      {alerts.map(({ meter, level }) => (
        <Alert key={meter} tone={level === 'full' ? 'error' : 'warning'}>
          <p>
            {t(`alert.${level}.${meter}`, {
              minutes: Math.max(1, Math.ceil((usage.compilesPerHour.nextSlotSeconds ?? 60) / 60)),
            })}{' '}
            <a href={pricing}>{t('upgrade')}</a>
          </p>
        </Alert>
      ))}

      <Panel
        title={t('planTitle')}
        actions={
          <ButtonLink href={pricing} variant="accent">
            {t('upgrade')}
          </ButtonLink>
        }
      >
        <div className={styles.panelBody}>
          <p className={styles.row}>
            <Badge tone={usage.plan.code === 'FREE' ? 'neutral' : 'accent'}>
              {t('plan', { plan: name(usage.plan.name) })}
            </Badge>
          </p>
          <ul className={styles.plainList}>
            {usage.sources.map((source, index) => (
              <li key={index}>
                {t(`source.${source.kind}`, {
                  plan: name(source.planName),
                  organization: source.organizationName ?? '',
                  date: source.periodEnd ? date(source.periodEnd) : '',
                })}
              </li>
            ))}
          </ul>
          {usage.sources.length > 1 && <p className={styles.muted}>{t('bestWins')}</p>}
        </div>
      </Panel>

      <UsageSummary
        plan={<span className={styles.label}>{t('quotasTitle')}</span>}
        items={meters.map(([meter, value]) => ({
          label: t(`meter.${meter}`),
          value: meterValue(meter, value),
          ratio: value.max ? value.used / value.max : undefined,
        }))}
      />

      <Panel title={t('limitsTitle')}>
        <dl className={styles.facts}>
          <div>
            <dt>{t('limit.collaborators')}</dt>
            <dd>
              {limits.maxCollaborators === null
                ? t('unlimited')
                : t('limit.collaboratorsValue', { max: limits.maxCollaborators })}
            </dd>
          </div>
          <div>
            <dt>{t('limit.compileSeconds')}</dt>
            <dd>{t('limit.duration', { seconds: limits.maxCompileSeconds })}</dd>
          </div>
          <div>
            <dt>{t('limit.history')}</dt>
            <dd>
              {limits.historyDays === null
                ? t('unlimited')
                : t('limit.historyValue', { days: limits.historyDays })}
            </dd>
          </div>
          <div>
            <dt>{t('limit.autoCompile')}</dt>
            <dd>{limits.autoCompile ? t('yes') : t('no')}</dd>
          </div>
          <div>
            <dt>{t('limit.priority')}</dt>
            <dd>{t(`priority.${limits.compilePriority}`)}</dd>
          </div>
          <div>
            <dt>{t('limit.supervision')}</dt>
            <dd>
              {!limits.supervisionDashboard
                ? t('no')
                : limits.maxSupervisedStudents === null
                  ? t('yes')
                  : t('limit.supervisionValue', { max: limits.maxSupervisedStudents })}
            </dd>
          </div>
        </dl>
      </Panel>

      <Panel
        title={t('monthTitle', {
          month: format.dateTime(new Date(usage.month.periodStart), {
            month: 'long',
            year: 'numeric',
            timeZone: 'UTC',
          }),
        })}
      >
        <dl className={styles.facts}>
          <div>
            <dt>{t('month.compilations')}</dt>
            <dd>{usage.month.compileCount}</dd>
          </div>
          <div>
            <dt>{t('month.minutes')}</dt>
            <dd>{compileTime}</dd>
          </div>
        </dl>
      </Panel>

      <Panel title={t('projectsTitle')}>
        {usage.readOnly.length > 0 && (
          <div className={styles.panelBody}>
            <Alert tone="info" announce={false}>
              <p>{t('readOnlyExplained', { max: usage.projects.max ?? 0 })}</p>
            </Alert>
          </div>
        )}
        <List label={t('projectsTitle')}>
          {usage.writable.map((project) => (
            <ProjectRow
              key={project.id}
              name={project.name}
              href={getPathname({ href: `/app/projects/${project.id}`, locale })}
              meta={t('lastActivity', { date: date(project.lastActivityAt) })}
              badge={
                <Badge tone="success" icon={CircleCheck}>
                  {t('writableBadge')}
                </Badge>
              }
            />
          ))}
          {usage.readOnly.map((project) => (
            <ProjectRow
              key={project.id}
              name={project.name}
              href={getPathname({ href: `/app/projects/${project.id}`, locale })}
              meta={t('lastActivity', { date: date(project.lastActivityAt) })}
              badge={<Badge icon={Lock}>{t('readOnlyBadge')}</Badge>}
              actions={
                <Button variant="secondary" onClick={() => setWritable(project)}>
                  {t('makeWritable')}
                </Button>
              }
            />
          ))}
        </List>
      </Panel>

      {writable && (
        <MakeWritableDialog
          open
          project={writable}
          usage={usage}
          onClose={() => setWritable(null)}
          onDone={() => router.refresh()}
        />
      )}
    </div>
  );
}
