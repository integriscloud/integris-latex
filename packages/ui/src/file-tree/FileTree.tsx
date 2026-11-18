'use client';

import { ChevronDown, ChevronRight, Lock, Star } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import {
  type FileTreeEntry,
  type FileTreeFolder,
  fileTypeLabel,
  type TreeFile,
} from './build-tree';
import styles from './file-tree.module.css';

export interface FileTreeProps {
  /** Accessible name of the tree. */
  label: string;
  entries: readonly FileTreeEntry[];
  /** Label of the main file marker, e.g. "Fichier principal". */
  mainLabel: string;
  lockedLabel: string;
  renderFileActions?: (file: TreeFile) => ReactNode;
  renderFolderActions?: (folder: FileTreeFolder) => ReactNode;
  /** Link opening a file (text files in the editor); files without one are plain text. */
  fileHref?: (file: TreeFile) => string | undefined;
  /** Opens a linked file in place (a plain click; Ctrl/⌘-click still follows the link). */
  onOpenFile?: (file: TreeFile) => void;
  /** File shown as open. */
  activeId?: string;
}

/** Files of a project (mockup "Fichiers"): folders can be folded, each row has its actions. */
export function FileTree({
  label,
  entries,
  mainLabel,
  lockedLabel,
  renderFileActions,
  renderFolderActions,
  fileHref,
  onOpenFile,
  activeId,
}: FileTreeProps) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());

  const toggle = (path: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const linkOf = (file: TreeFile, name: string) => {
    const href = fileHref?.(file);
    if (!href) return <span className={styles.name}>{name}</span>;
    return (
      <a
        className={`${styles.name} ${styles.link}`}
        href={href}
        aria-current={file.id === activeId ? 'page' : undefined}
        onClick={(event) => {
          if (!onOpenFile || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
            return;
          }
          event.preventDefault();
          onOpenFile(file);
        }}
      >
        {name}
      </a>
    );
  };

  const render = (items: readonly FileTreeEntry[], depth: number): ReactNode => (
    <ul className={styles.list}>
      {items.map((entry) =>
        entry.type === 'folder' ? (
          <li key={`d:${entry.path}`}>
            <div className={styles.row} data-depth={Math.min(depth, 6)}>
              <button
                type="button"
                className={styles.folder}
                aria-expanded={!folded.has(entry.path)}
                onClick={() => toggle(entry.path)}
              >
                {folded.has(entry.path) ? (
                  <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
                ) : (
                  <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" />
                )}
                <span className={`${styles.type} ${styles.dir}`} aria-hidden="true">
                  DIR
                </span>
                <span className={styles.name}>{entry.name}/</span>
              </button>
              {renderFolderActions && (
                <span className={styles.actions}>{renderFolderActions(entry)}</span>
              )}
            </div>
            {!folded.has(entry.path) && render(entry.children, depth + 1)}
          </li>
        ) : (
          <li key={`f:${entry.file.id}`}>
            <div
              className={styles.row}
              data-depth={Math.min(depth, 6)}
              data-active={entry.file.id === activeId || undefined}
            >
              <span className={styles.file}>
                <span className={styles.type} aria-hidden="true">
                  {fileTypeLabel(entry.name)}
                </span>
                {linkOf(entry.file, entry.name)}
                {entry.file.main && (
                  <span className={styles.marker} title={mainLabel}>
                    <Star size={14} strokeWidth={1.75} aria-hidden="true" />
                    <span className={styles.markerText}>{mainLabel}</span>
                  </span>
                )}
                {entry.file.locked && (
                  <span className={styles.marker} title={lockedLabel}>
                    <Lock size={14} strokeWidth={1.75} aria-hidden="true" />
                    <span className={styles.markerText}>{lockedLabel}</span>
                  </span>
                )}
                <span className={styles.size}>{entry.file.size}</span>
              </span>
              {renderFileActions && (
                <span className={styles.actions}>{renderFileActions(entry.file)}</span>
              )}
            </div>
          </li>
        ),
      )}
    </ul>
  );

  return (
    <div className={styles.tree} role="group" aria-label={label}>
      {render(entries, 0)}
    </div>
  );
}
