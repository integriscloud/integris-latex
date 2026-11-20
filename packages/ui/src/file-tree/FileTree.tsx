'use client';

import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  FileText,
  FileType,
  Folder,
  FolderOpen,
  FolderRoot,
  Image,
  Lock,
  type LucideIcon,
  Settings2,
  Star,
} from 'lucide-react';
import {
  type DragEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { IconButton } from '../icon-button/IconButton';
import {
  type FileIconKind,
  fileIconKind,
  type FileTreeEntry,
  type FileTreeFolder,
  type TreeFile,
} from './build-tree';
import styles from './file-tree.module.css';
import { RowMenu, type TreeMenuItem } from './RowMenu';

const FILE_ICONS: Record<FileIconKind, LucideIcon> = {
  text: FileText,
  bibliography: BookOpen,
  image: Image,
  pdf: FileType,
  style: Settings2,
};

export interface FileTreeProps {
  /** Accessible name of the tree. */
  label: string;
  entries: readonly FileTreeEntry[];
  /** Label of the main file marker, e.g. "Fichier principal". */
  mainLabel: string;
  lockedLabel: string;
  /** Name of the row standing for the root of the project ("Racine du projet"); no row without. */
  rootLabel?: string;
  /** Link opening a file (text files in the editor); files without one are plain text. */
  fileHref?: (file: TreeFile) => string | undefined;
  /** Opens a linked file in place (a plain click; Ctrl/⌘-click still follows the link). */
  onOpenFile?: (file: TreeFile) => void;
  /** File shown as open. */
  activeId?: string;
  /** Current folder ("" for the root): where "New file" and "New folder" create by default. */
  selectedFolder?: string | null;
  onSelectFolder?: (path: string) => void;
  /** Actions of the "…" menu of each row (also opened by a long press or a right click). */
  fileMenu?: (file: TreeFile) => TreeMenuItem[];
  folderMenu?: (folder: FileTreeFolder) => TreeMenuItem[];
  rootMenu?: TreeMenuItem[];
  /** Accessible name of a "…" button, from the name of its row. */
  menuLabel?: (name: string) => string;
  /**
   * Moves a file or a folder dropped on a folder (or on a file of that folder, on the root row,
   * or on the empty space of the tree for the root ""). Without it, nothing can be dragged; the
   * app also offers "Move to…" for keyboards and touch screens.
   */
  onMove?: (entry: FileTreeEntry, folder: string) => void;
  /** Folds are remembered in this browser under this key (one per project). */
  storageKey?: string;
  /** A path whose folders are unfolded when it changes (a file just created). */
  reveal?: string | null;
}

/** Folder holding a path ("" for the root). */
const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf('/'), 0));

// Type of the dragged data: never text, so a drop in the code editor inserts nothing.
const DRAG_TYPE = 'application/x-integris-tree-entry';
const LONG_PRESS_MS = 500;

// Folded folders, per storage key: kept in memory and, when possible, in localStorage.
const folds = new Map<string, string>();
const foldListeners = new Set<() => void>();
const readFolds = (key: string) => {
  if (!folds.has(key)) {
    let stored = '';
    try {
      stored = window.localStorage.getItem(key) ?? '';
    } catch {
      // Storage unavailable: folds last for this page only.
    }
    folds.set(key, stored);
  }
  return folds.get(key)!;
};
const writeFolds = (key: string, paths: ReadonlySet<string>) => {
  const value = JSON.stringify([...paths]);
  folds.set(key, value);
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not remembered: unfolded on the next visit.
  }
  for (const listener of foldListeners) listener();
};
const subscribeFolds = (listener: () => void) => {
  foldListeners.add(listener);
  return () => foldListeners.delete(listener);
};
const parseFolds = (value: string): ReadonlySet<string> => {
  try {
    const parsed: unknown = JSON.parse(value || '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
};

/** Long press on a touch screen: opens a menu, and the click that ends it is ignored. */
class LongPress {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private x = 0;
  private y = 0;
  private suppress = false;

  start(event: PointerEvent, done: () => void) {
    this.cancel();
    this.x = event.clientX;
    this.y = event.clientY;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.suppress = true;
      done();
    }, LONG_PRESS_MS);
  }

  move(event: PointerEvent) {
    if (this.timer && Math.hypot(event.clientX - this.x, event.clientY - this.y) > 10) {
      this.cancel();
    }
  }

  cancel() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** True once for the click ending a long press. */
  takeClick() {
    const suppress = this.suppress;
    this.suppress = false;
    return suppress;
  }
}

// Touch screens open the menu with a long press: rows are not dragged there.
const coarseQuery = '(pointer: coarse)';
const subscribeCoarse = (listener: () => void) => {
  const query = window.matchMedia(coarseQuery);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
};

/**
 * Files of a project: folders first, folded with their chevron (remembered), an icon per file
 * type, the current folder and the open file highlighted. Each row has a "…" menu (keyboard,
 * long press on touch screens, right click); folders also show their quick actions on hover.
 * Files and folders move by drag and drop on a folder or on the root row.
 */
export function FileTree({
  label,
  entries,
  mainLabel,
  lockedLabel,
  rootLabel,
  fileHref,
  onOpenFile,
  activeId,
  selectedFolder,
  onSelectFolder,
  fileMenu,
  folderMenu,
  rootMenu,
  menuLabel = (name) => name,
  onMove,
  storageKey = 'integris.tree.folded',
  reveal,
}: FileTreeProps) {
  const foldedValue = useSyncExternalStore(
    subscribeFolds,
    () => readFolds(storageKey),
    () => '',
  );
  const folded = useMemo(() => parseFolds(foldedValue), [foldedValue]);
  const coarse = useSyncExternalStore(
    subscribeCoarse,
    () => window.matchMedia(coarseQuery).matches,
    () => false,
  );
  const [dragged, setDragged] = useState<FileTreeEntry | null>(null);
  // Folder the dragged entry would go to ("" for the root).
  const [target, setTarget] = useState<string | null>(null);
  // Row whose "…" menu is open: "/" for the root, "d:<path>" or "f:<id>".
  const [menu, setMenu] = useState<string | null>(null);
  const [longPress] = useState(() => new LongPress());

  const toggle = (path: string) => {
    const next = new Set(folded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    writeFolds(storageKey, next);
  };

  // A file just created: its folders unfold.
  useEffect(() => {
    if (!reveal) return;
    const current = parseFolds(readFolds(storageKey));
    const next = new Set(
      [...current].filter((path) => !(reveal === path || reveal.startsWith(`${path}/`))),
    );
    if (next.size !== current.size) writeFolds(storageKey, next);
  }, [reveal, storageKey]);

  const canDrop = (folder: string) =>
    dragged !== null &&
    parentOf(dragged.path) !== folder &&
    !(
      dragged.type === 'folder' &&
      (folder === dragged.path || folder.startsWith(`${dragged.path}/`))
    );

  const dragProps = (entry: FileTreeEntry) =>
    onMove && !coarse
      ? {
          draggable: true,
          onDragStart: (event: DragEvent) => {
            event.stopPropagation();
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData(DRAG_TYPE, entry.path);
            setDragged(entry);
          },
          onDragEnd: () => {
            setDragged(null);
            setTarget(null);
          },
        }
      : {};

  const dropProps = (folder: string) =>
    onMove
      ? {
          onDragOver: (event: DragEvent) => {
            if (!dragged) return;
            // Rows never let the event reach the tree (which stands for the root).
            event.stopPropagation();
            if (!canDrop(folder)) {
              if (target !== null) setTarget(null);
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            if (target !== folder) setTarget(folder);
          },
          onDrop: (event: DragEvent) => {
            if (!dragged) return;
            event.stopPropagation();
            event.preventDefault();
            const entry = dragged;
            setDragged(null);
            setTarget(null);
            if (canDrop(folder)) onMove(entry, folder);
          },
        }
      : {};

  /** Long press (touch) and right click open the "…" menu of the row. */
  const menuProps = (key: string, items: readonly TreeMenuItem[] | undefined) =>
    items?.length
      ? {
          onContextMenu: (event: MouseEvent) => {
            event.preventDefault();
            longPress.cancel();
            setMenu(key);
          },
          onPointerDown: (event: PointerEvent) => {
            if (event.pointerType === 'touch') longPress.start(event, () => setMenu(key));
          },
          onPointerMove: (event: PointerEvent) => longPress.move(event),
          onPointerUp: () => longPress.cancel(),
          onPointerCancel: () => longPress.cancel(),
          // The click ending a long press does not open the file or fold the folder.
          onClickCapture: (event: MouseEvent) => {
            if (!longPress.takeClick()) return;
            event.preventDefault();
            event.stopPropagation();
          },
        }
      : {};

  const actions = (key: string, name: string, items: readonly TreeMenuItem[] | undefined) =>
    items?.length ? (
      <span className={styles.actions}>
        {items
          .filter((item) => item.quick)
          .map((item) => (
            <IconButton
              key={item.id}
              icon={item.icon}
              label={item.quickLabel ?? item.label}
              disabled={item.disabled}
              className={styles.quick}
              onClick={item.onSelect}
            />
          ))}
        <RowMenu
          label={menuLabel(name)}
          items={items}
          open={menu === key}
          onOpenChange={(open) => setMenu(open ? key : null)}
        />
      </span>
    ) : null;

  const linkOf = (file: TreeFile, name: string) => {
    const href = fileHref?.(file);
    if (!href) return <span className={styles.name}>{name}</span>;
    return (
      <a
        className={`${styles.name} ${styles.link}`}
        href={href}
        // The row is dragged, not the link.
        draggable={onMove ? false : undefined}
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
      {items.map((entry) => {
        if (entry.type === 'folder') {
          const open = !folded.has(entry.path);
          const key = `d:${entry.path}`;
          const items = folderMenu?.(entry);
          const Icon = open ? FolderOpen : Folder;
          return (
            <li key={key}>
              <div
                className={styles.row}
                data-depth={Math.min(depth, 8)}
                data-drop={target === entry.path || undefined}
                data-dragged={dragged?.path === entry.path || undefined}
                data-selected={selectedFolder === entry.path || undefined}
                {...dragProps(entry)}
                {...dropProps(entry.path)}
                {...menuProps(key, items)}
              >
                <button
                  type="button"
                  className={styles.folder}
                  aria-expanded={open}
                  aria-current={selectedFolder === entry.path ? 'true' : undefined}
                  onClick={() => {
                    toggle(entry.path);
                    onSelectFolder?.(entry.path);
                  }}
                >
                  {open ? (
                    <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" />
                  ) : (
                    <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
                  )}
                  <Icon
                    className={styles.folderIcon}
                    size={18}
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                  <span className={styles.name}>{entry.name}</span>
                </button>
                {actions(key, entry.path, items)}
              </div>
              {open && entry.children.length > 0 && render(entry.children, depth + 1)}
            </li>
          );
        }
        const key = `f:${entry.file.id}`;
        const items = fileMenu?.(entry.file);
        const Icon = FILE_ICONS[fileIconKind(entry.name)];
        return (
          <li key={key}>
            <div
              className={styles.row}
              data-depth={Math.min(depth, 8)}
              data-active={entry.file.id === activeId || undefined}
              data-dragged={dragged?.path === entry.path || undefined}
              {...dragProps(entry)}
              {...dropProps(parentOf(entry.path))}
              {...menuProps(key, items)}
            >
              <span className={styles.file}>
                <span className={styles.chevronSpace} aria-hidden="true" />
                <Icon className={styles.fileIcon} size={18} strokeWidth={1.75} aria-hidden="true" />
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
              {actions(key, entry.path, items)}
            </div>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div
      className={styles.tree}
      role="group"
      aria-label={label}
      data-drop={target === '' || undefined}
      {...dropProps('')}
      onDragLeave={(event) => {
        // Left the tree: no target shown any more.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTarget(null);
      }}
    >
      {rootLabel !== undefined && (
        <div
          className={styles.row}
          data-root
          data-drop={target === '' || undefined}
          data-selected={selectedFolder === '' || undefined}
          {...dropProps('')}
          {...menuProps('/', rootMenu)}
        >
          <button
            type="button"
            className={styles.folder}
            aria-current={selectedFolder === '' ? 'true' : undefined}
            onClick={() => onSelectFolder?.('')}
          >
            <FolderRoot
              className={styles.folderIcon}
              size={18}
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <span className={styles.name}>{rootLabel}</span>
          </button>
          {actions('/', rootLabel, rootMenu)}
        </div>
      )}
      {render(entries, rootLabel === undefined ? 0 : 1)}
    </div>
  );
}
