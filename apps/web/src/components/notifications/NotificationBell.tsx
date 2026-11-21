'use client';

import { Bell } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { apiRead } from '../../lib/api-client';
import styles from './notifications.module.css';

const REFRESH_MS = 60_000;

/** Bell of the top bar: link to the notification centre with the number of unread notices. */
export function NotificationBell({ href, initial }: { href: string; initial: number }) {
  const t = useTranslations('Notifications');
  const [unread, setUnread] = useState(initial);

  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      if (document.visibilityState !== 'visible') return;
      const result = await apiRead<{ unread: number }>('notifications/unread');
      if (!stopped && result.ok) setUnread(result.data.unread);
    };
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  return (
    <a className={styles.bell} href={href} aria-label={t('bell', { count: unread })}>
      <Bell size={24} strokeWidth={1.75} aria-hidden />
      {unread > 0 && (
        <span className={styles.count} aria-hidden>
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </a>
  );
}
