'use client';

import { Upload } from 'lucide-react';
import { type DragEvent, useId, useState } from 'react';
import styles from './file-drop.module.css';

export interface FileDropProps {
  /** Visible call to action, e.g. "Choisir un fichier ZIP". */
  label: string;
  /** Second line, e.g. "ou déposez-le ici · 50 Mo maximum". */
  hint?: string;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
}

/** File picker that also accepts a drag and drop (a real `<input type="file">` inside a label). */
export function FileDrop({ label, hint, accept, multiple, disabled, onFiles }: FileDropProps) {
  const id = useId();
  const [over, setOver] = useState(false);

  const drop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    if (!disabled && event.dataTransfer.files.length) onFiles([...event.dataTransfer.files]);
  };

  return (
    <label
      htmlFor={id}
      className={[styles.drop, over && styles.over, disabled && styles.disabled]
        .filter(Boolean)
        .join(' ')}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
    >
      <input
        id={id}
        type="file"
        className={styles.input}
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
      <Upload size={24} strokeWidth={1.75} aria-hidden="true" />
      <span className={styles.label}>{label}</span>
      {hint && <span className={styles.hint}>{hint}</span>}
    </label>
  );
}
