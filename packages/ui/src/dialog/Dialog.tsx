'use client';

import { X } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useRef } from 'react';
import styles from './dialog.module.css';

export interface DialogProps {
  open: boolean;
  title: string;
  /** Accessible name of the close button. */
  closeLabel: string;
  onClose: () => void;
  /** When set, the content is a form and Enter submits it. */
  onSubmit?: () => void;
  /** Buttons at the bottom (the submit button has `type="submit"`). */
  actions: ReactNode;
  children?: ReactNode;
}

/** Modal dialog (native `<dialog>`: focus trap, Escape and backdrop handled by the browser). */
export function Dialog({
  open,
  title,
  closeLabel,
  onClose,
  onSubmit,
  actions,
  children,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit?.();
  };

  const body = (
    <>
      <div className={styles.head}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <button type="button" className={styles.close} aria-label={closeLabel} onClick={onClose}>
          <X size={20} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      {children && <div className={styles.content}>{children}</div>}
      <div className={styles.actions}>{actions}</div>
    </>
  );

  return (
    <dialog ref={ref} className={styles.dialog} aria-labelledby={titleId} onClose={onClose}>
      {/* Content only while open: a closed dialog leaves no field behind. */}
      {open &&
        (onSubmit ? (
          <form className={styles.form} onSubmit={submit}>
            {body}
          </form>
        ) : (
          <div className={styles.form}>{body}</div>
        ))}
    </dialog>
  );
}
