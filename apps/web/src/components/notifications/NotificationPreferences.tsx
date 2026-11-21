'use client';

import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategoryValue,
  type NotificationPreferences as Preferences,
} from '@integris/shared';
import { Alert, Button, Checkbox } from '@integris/ui';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { apiRequest } from '../../lib/api-client';
import styles from './notifications.module.css';

/**
 * E-mail copies of the notifications, per category (off by default). SMS are not optional, and
 * e-mail needs a verified address.
 */
export function NotificationPreferences({ initial }: { initial: Preferences }) {
  const t = useTranslations('Notifications.preferences');
  const [chosen, setChosen] = useState<NotificationCategoryValue[]>(initial.email);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<'saved' | 'failed' | null>(null);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setState(null);
    const result = await apiRequest<Preferences>('PUT', 'notifications/preferences', {
      email: chosen,
    });
    setBusy(false);
    if (!result.ok) return setState('failed');
    setChosen(result.data.email);
    setState('saved');
  };

  return (
    <form className={styles.stack} onSubmit={save}>
      <p className={styles.muted}>{t('text')}</p>
      {!initial.emailAvailable && (
        <Alert tone="info">
          <p>{t('noEmail')}</p>
        </Alert>
      )}
      <fieldset className={styles.preferences} disabled={!initial.emailAvailable}>
        <legend className={styles.srOnly}>{t('legend')}</legend>
        {NOTIFICATION_CATEGORIES.map((category) => (
          <Checkbox
            key={category}
            checked={chosen.includes(category)}
            onChange={(event) =>
              setChosen((list) =>
                event.target.checked
                  ? [...list, category]
                  : list.filter((item) => item !== category),
              )
            }
          >
            {t(`categories.${category}`)}
          </Checkbox>
        ))}
      </fieldset>
      {state === 'saved' && (
        <Alert tone="success">
          <p>{t('saved')}</p>
        </Alert>
      )}
      {state === 'failed' && (
        <Alert tone="error">
          <p>{t('failed')}</p>
        </Alert>
      )}
      <div>
        <Button type="submit" variant="secondary" busy={busy} disabled={!initial.emailAvailable}>
          {t('save')}
        </Button>
      </div>
    </form>
  );
}
