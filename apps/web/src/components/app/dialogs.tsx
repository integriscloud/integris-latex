'use client';

import { Alert, Button, Dialog, TextField } from '@integris/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

export interface TextDialogProps {
  open: boolean;
  title: string;
  label: string;
  help?: string;
  initial: string;
  submitLabel: string;
  /** Resolves to an error message, or null on success (the dialog then closes). */
  onSubmit: (value: string) => Promise<string | null>;
  onClose: () => void;
}

/** Dialog asking for one value: a project name, a file path. */
export function TextDialog({
  open,
  title,
  label,
  help,
  initial,
  submitLabel,
  onSubmit,
  onClose,
}: TextDialogProps) {
  const t = useTranslations('App');
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh value and no error each time the dialog opens (state adjusted during render).
  const [shown, setShown] = useState(open);
  if (open !== shown) {
    setShown(open);
    if (open) {
      setValue(initial);
      setError(null);
    }
  }

  const submit = async () => {
    if (!value.trim()) return;
    setBusy(true);
    const message = await onSubmit(value.trim());
    setBusy(false);
    if (message) setError(message);
    else onClose();
  };

  return (
    <Dialog
      open={open}
      title={title}
      closeLabel={t('close')}
      onClose={onClose}
      onSubmit={submit}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" busy={busy} disabled={!value.trim()}>
            {submitLabel}
          </Button>
        </>
      }
    >
      {error && <Alert tone="error">{error}</Alert>}
      <TextField
        label={label}
        help={help}
        value={value}
        maxLength={300}
        autoFocus
        onChange={(event) => setValue(event.target.value)}
      />
    </Dialog>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  text: string;
  confirmLabel: string;
  /** Resolves to an error message, or null on success (the dialog then closes). */
  onConfirm: () => Promise<string | null>;
  onClose: () => void;
}

/** Confirmation of an action (moving to the trash, erasing for good). */
export function ConfirmDialog({
  open,
  title,
  text,
  confirmLabel,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const t = useTranslations('App');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [shown, setShown] = useState(open);
  if (open !== shown) {
    setShown(open);
    if (open) setError(null);
  }

  const confirm = async () => {
    setBusy(true);
    const message = await onConfirm();
    setBusy(false);
    if (message) setError(message);
    else onClose();
  };

  return (
    <Dialog
      open={open}
      title={title}
      closeLabel={t('close')}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button busy={busy} onClick={confirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {error && <Alert tone="error">{error}</Alert>}
      <p>{text}</p>
    </Dialog>
  );
}
