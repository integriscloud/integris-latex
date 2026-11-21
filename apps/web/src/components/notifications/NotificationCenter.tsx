'use client';

import {
  NOTIFICATION_TYPE_NAMES,
  type NotificationItem,
  type NotificationsPage,
} from '@integris/shared';
import { Alert, Button, EmptyState } from '@integris/ui';
import { BellOff, CheckCheck } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { getPathname } from '../../i18n/navigation';
import { apiPost, apiRead } from '../../lib/api-client';
import { notificationHref } from './notification-links';
import styles from './notifications.module.css';

const KNOWN: readonly string[] = NOTIFICATION_TYPE_NAMES;

/** Notification centre: newest first, unread highlighted, read on opening, older on demand. */
export function NotificationCenter({ initial }: { initial: NotificationsPage }) {
  const t = useTranslations('Notifications');
  const locale = useLocale();
  const format = useFormatter();
  const [items, setItems] = useState(initial.items);
  const [unread, setUnread] = useState(initial.unread);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [busy, setBusy] = useState<'more' | 'all' | null>(null);
  const [failed, setFailed] = useState(false);

  const date = (value: unknown) =>
    typeof value === 'string' ? format.dateTime(new Date(value), { dateStyle: 'long' }) : '';

  const text = (item: NotificationItem) => {
    if (!KNOWN.includes(item.type)) return t('unknown');
    const p = item.payload;
    return t(`types.${item.type}` as 'types.PRINT_READY', {
      title: typeof p.title === 'string' && p.title ? p.title : t('untitled'),
      name: typeof p.name === 'string' ? p.name : '',
      date: date(p.date),
      dueAt: date(p.dueAt),
      amount: typeof p.amountXof === 'number' ? p.amountXof : 0,
      count: typeof p.count === 'number' ? p.count : 0,
      to: typeof p.to === 'string' ? p.to : '',
      quota: typeof p.quota === 'string' ? p.quota : 'other',
      level: typeof p.level === 'string' ? p.level : 'warn',
      plan: typeof p.planCode === 'string' ? p.planCode : '',
    });
  };

  const markRead = async (ids: string[]) => {
    if (!ids.length) return;
    const result = await apiPost('notifications/read', { ids });
    if (!result.ok) return;
    const now = new Date().toISOString();
    setItems((list) =>
      list.map((item) => (ids.includes(item.id) ? { ...item, readAt: now } : item)),
    );
    setUnread((count) => Math.max(0, count - ids.length));
  };

  const readAll = async () => {
    setBusy('all');
    const result = await apiPost('notifications/read-all');
    setBusy(null);
    if (!result.ok) return setFailed(true);
    const now = new Date().toISOString();
    setItems((list) => list.map((item) => ({ ...item, readAt: item.readAt ?? now })));
    setUnread(0);
  };

  const more = async () => {
    if (!cursor) return;
    setBusy('more');
    const result = await apiRead<NotificationsPage>(
      `notifications?before=${encodeURIComponent(cursor)}`,
    );
    setBusy(null);
    if (!result.ok) return setFailed(true);
    setItems((list) => [...list, ...result.data.items]);
    setCursor(result.data.nextCursor);
  };

  if (!items.length) {
    return <EmptyState icon={BellOff} title={t('emptyTitle')} text={t('emptyText')} />;
  }

  return (
    <div className={styles.stack}>
      <div className={styles.toolbar}>
        <p className={styles.muted} aria-live="polite">
          {t('unread', { count: unread })}
        </p>
        <Button variant="secondary" busy={busy === 'all'} disabled={unread === 0} onClick={readAll}>
          <CheckCheck size={20} strokeWidth={1.75} aria-hidden />
          {t('readAll')}
        </Button>
      </div>
      {failed && (
        <Alert tone="error">
          <p>{t('failed')}</p>
        </Alert>
      )}
      <ul className={styles.list}>
        {items.map((item) => {
          const href = notificationHref(item);
          const label = text(item);
          return (
            <li
              key={item.id}
              className={`${styles.item} ${item.readAt ? styles.read : styles.unread}`}
            >
              <span className={styles.dot} aria-hidden />
              <div className={styles.body}>
                <p className={styles.text}>
                  {!item.readAt && <span className={styles.srOnly}>{t('new')} </span>}
                  {href ? (
                    <a
                      className={styles.link}
                      href={getPathname({ href, locale })}
                      onClick={() => void markRead(item.readAt ? [] : [item.id])}
                    >
                      {label}
                    </a>
                  ) : (
                    label
                  )}
                </p>
                <p className={styles.muted}>
                  {format.dateTime(new Date(item.createdAt), {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </p>
              </div>
              {!item.readAt && (
                <Button variant="ghost" onClick={() => void markRead([item.id])}>
                  {t('markRead')}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {cursor && (
        <div>
          <Button variant="secondary" busy={busy === 'more'} onClick={more}>
            {t('more')}
          </Button>
        </div>
      )}
    </div>
  );
}
