'use client';

import { Alert, Button, Dialog } from '@integris/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

/**
 * The stored file changed since it was opened (another tab, another member): the user keeps
 * their version (it replaces the stored one) or loads the stored one (their changes are dropped).
 * Nothing is overwritten without this choice.
 */
export function ConflictDialog({
  open,
  path,
  onResolve,
  onClose,
}: {
  open: boolean;
  path: string;
  /** "Later": the conflict stays shown above the editor until a choice is made. */
  onClose: () => void;
  /** Resolves to an error message, or null when done. */
  onResolve: (keepMine: boolean) => Promise<string | null>;
}) {
  const t = useTranslations('Editor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolve = async (keepMine: boolean) => {
    setBusy(true);
    setError(null);
    setError(await onResolve(keepMine));
    setBusy(false);
  };

  return (
    <Dialog
      open={open}
      title={t('conflictTitle')}
      closeLabel={t('conflictLater')}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" busy={busy} onClick={() => void resolve(false)}>
            {t('conflictReload')}
          </Button>
          <Button busy={busy} onClick={() => void resolve(true)}>
            {t('conflictKeep')}
          </Button>
        </>
      }
    >
      <p>{t('conflictText', { path })}</p>
      {error && <Alert tone="error">{error}</Alert>}
    </Dialog>
  );
}
