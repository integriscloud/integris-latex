'use client';

import { type AccountUsage, accountUsageSchema } from '@integris/shared';
import { Alert, Button, ChoiceCards, Dialog } from '@integris/ui';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { apiRead, apiRequest } from '../../lib/api-client';
import { useApiErrorMessage } from './use-api-error';

export interface MakeWritableDialogProps {
  open: boolean;
  project: { id: string; name: string };
  /** Usage already loaded (page "Ma consommation"); otherwise read when the dialog opens. */
  usage?: AccountUsage;
  onClose: () => void;
  /** The project is writable now. */
  onDone: () => void;
}

/**
 * "Rendre ce projet modifiable" (docs/spec.md, "Lecture seule au-delà des limites"): when every
 * writable place of the plan is taken, the owner picks the project that becomes read-only.
 */
export function MakeWritableDialog({
  open,
  project,
  usage: given,
  onClose,
  onDone,
}: MakeWritableDialogProps) {
  const t = useTranslations('Usage.writable');
  const tApp = useTranslations('App');
  const locale = useLocale();
  const format = useFormatter();
  const message = useApiErrorMessage(locale);
  const [usage, setUsage] = useState<AccountUsage | null>(given ?? null);
  const [release, setRelease] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh state each time the dialog opens (state adjusted during render).
  const [shown, setShown] = useState(false);
  if (open !== shown) {
    setShown(open);
    if (open) {
      setError(null);
      setRelease('');
      setUsage(given ?? null);
    }
  }

  useEffect(() => {
    if (!open || given) return;
    let live = true;
    void apiRead<unknown>('usage').then((result) => {
      if (!live) return;
      if (result.ok) setUsage(accountUsageSchema.parse(result.data));
      else setError(message(result.error));
    });
    return () => {
      live = false;
    };
  }, [open, given, message]);

  const max = usage?.projects.max ?? null;
  const full = usage !== null && max !== null && usage.writable.length >= max;

  const submit = async () => {
    if (!usage || (full && !release)) return;
    setBusy(true);
    const result = await apiRequest('POST', `projects/${project.id}/writable`, {
      ...(full ? { release } : {}),
    });
    setBusy(false);
    if (!result.ok) return setError(message(result.error));
    onDone();
    onClose();
  };

  return (
    <Dialog
      open={open}
      title={t('title', { name: project.name })}
      closeLabel={tApp('close')}
      onClose={onClose}
      onSubmit={submit}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            {tApp('cancel')}
          </Button>
          <Button type="submit" busy={busy} disabled={!usage || (full && !release)}>
            {t('confirm')}
          </Button>
        </>
      }
    >
      {error && <Alert tone="error">{error}</Alert>}
      {usage && !full && <p>{t('free')}</p>}
      {usage && full && (
        <ChoiceCards
          label={t('choose', { max: max ?? 0 })}
          value={release}
          onChange={setRelease}
          options={usage.writable.map((item) => ({
            value: item.id,
            title: item.name,
            description: t('lastActivity', {
              date: format.dateTime(new Date(item.lastActivityAt), { dateStyle: 'medium' }),
            }),
          }))}
        />
      )}
    </Dialog>
  );
}
