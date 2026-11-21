'use client';

import type { PrintRequestView, SecretariatQueue } from '@integris/shared';
import { Alert, ButtonLink, EmptyState, Panel, Tabs } from '@integris/ui';
import { Inbox, Lock } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { getPathname } from '../../i18n/navigation';
import styles from './exams.module.css';
import { PrintBadge, useFormatLabel } from './print-shared';

type QueueTab = 'toPrint' | 'scheduled' | 'toHandOver';

const TAB_STATUSES: Record<QueueTab, PrintRequestView['status'][]> = {
  toPrint: ['READY', 'OPENED'],
  scheduled: ['SCHEDULED'],
  toHandOver: ['PRINTED'],
};

/** One request in a list of the secretariat: what, for whom, when, and the way in. */
export function PrintRequestRows({
  requests,
  emptyTitle,
}: {
  requests: PrintRequestView[];
  emptyTitle: string;
}) {
  const t = useTranslations('Secretariat.queue');
  const tPrint = useTranslations('Print');
  const locale = useLocale();
  const format = useFormatter();
  const formatLabel = useFormatLabel();
  const day = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });
  if (!requests.length) return <EmptyState icon={Inbox} title={emptyTitle} />;
  return (
    <ul className={styles.list}>
      {requests.map((request) => (
        <li key={request.id} className={styles.card}>
          <div className={styles.who}>
            <div className={styles.badges}>
              <p className={styles.name}>{request.title}</p>
              <PrintBadge status={request.status} />
            </div>
            <p className={styles.muted}>
              {[
                request.teacherName,
                request.groupName,
                tPrint('copiesTotal', { count: request.copies + request.reserveCopies }),
                formatLabel(request),
              ].join(' · ')}
            </p>
            <p className={styles.muted}>
              {t('dates', { ready: day(request.availableFrom), exam: day(request.examAt) })}
            </p>
          </div>
          <div className={styles.actions}>
            {request.locked ? (
              <p className={styles.muted}>
                <Lock size={16} strokeWidth={1.75} aria-hidden="true" />{' '}
                {t('openableOn', { date: day(request.availableFrom) })}
              </p>
            ) : null}
            <ButtonLink
              variant={request.locked ? 'secondary' : 'primary'}
              href={getPathname({ href: `/app/print/${request.id}`, locale })}
            >
              {request.status === 'READY' ? t('openAndPrint') : t('see')}
            </ButtonLink>
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * "File d'impression" of a secretariat (mockup secretariat-01, rebuilt): the requests of the
 * groups it serves, to print, scheduled (still locked) and printed waiting for their handover.
 */
export function SecretariatQueueView({ data }: { data: SecretariatQueue }) {
  const t = useTranslations('Secretariat.queue');
  const [tab, setTab] = useState<QueueTab>('toPrint');
  const count = (which: QueueTab) =>
    data.requests.filter((request) => TAB_STATUSES[which].includes(request.status)).length;
  const shown = data.requests.filter((request) => TAB_STATUSES[tab].includes(request.status));
  return (
    <div className={styles.stack}>
      <dl className={styles.stats}>
        <div className={styles.stat}>
          <dt>{t('stats.toPrint')}</dt>
          <dd>{data.stats.toPrint}</dd>
          <p className={styles.muted}>
            {t('stats.examTomorrow', { count: data.stats.examTomorrow })}
          </p>
        </div>
        <div className={styles.stat}>
          <dt>{t('stats.scheduled')}</dt>
          <dd>{data.stats.scheduled}</dd>
          <p className={styles.muted}>{t('stats.locked')}</p>
        </div>
        <div className={styles.stat}>
          <dt>{t('stats.printedThisWeek')}</dt>
          <dd>{data.stats.printedThisWeek}</dd>
          <p className={styles.muted}>{t('stats.toHandOver', { count: data.stats.toHandOver })}</p>
        </div>
        <div className={styles.stat}>
          <dt>{t('stats.copiesThisMonth')}</dt>
          <dd>{data.stats.copiesThisMonth}</dd>
          <p className={styles.muted}>
            {t('stats.requestsThisMonth', { count: data.stats.requestsThisMonth })}
          </p>
        </div>
      </dl>
      <Alert tone="info">
        <p>
          <strong>{t('confidentialTitle')}</strong> {t('confidential')}
        </p>
      </Alert>
      <Panel>
        <div className={styles.stack}>
          <Tabs
            label={t('tabsLabel')}
            idPrefix="print-queue"
            value={tab}
            onChange={(id) => setTab(id as QueueTab)}
            items={(['toPrint', 'scheduled', 'toHandOver'] as const).map((id) => ({
              id,
              label: t(`tabs.${id}`, { count: count(id) }),
            }))}
          />
          <div
            role="tabpanel"
            id={`print-queue-panel-${tab}`}
            aria-labelledby={`print-queue-tab-${tab}`}
          >
            <PrintRequestRows requests={shown} emptyTitle={t(`empty.${tab}`)} />
          </div>
        </div>
      </Panel>
    </div>
  );
}

/** "Historique": requests handed over or canceled, most recent first. */
export function PrintHistoryView({ requests }: { requests: PrintRequestView[] }) {
  const t = useTranslations('Secretariat.history');
  return (
    <Panel>
      <PrintRequestRows requests={requests} emptyTitle={t('empty')} />
    </Panel>
  );
}
