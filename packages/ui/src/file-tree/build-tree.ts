/** A project file as shown in the tree. */
export interface TreeFile {
  id: string;
  path: string;
  /** Readable size, e.g. "12 Ko". */
  size: string;
  main?: boolean;
  locked?: boolean;
}

export interface FileTreeFolder {
  type: 'folder';
  name: string;
  path: string;
  children: FileTreeEntry[];
}

export interface FileTreeLeaf {
  type: 'file';
  name: string;
  path: string;
  file: TreeFile;
}

export type FileTreeEntry = FileTreeFolder | FileTreeLeaf;

const byName = (a: FileTreeEntry, b: FileTreeEntry) =>
  a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.name.localeCompare(b.name);

/** Nested folders from flat paths ("chapitres/intro.tex"); folders first, then names. */
export function buildFileTree(files: readonly TreeFile[]): FileTreeEntry[] {
  const root: FileTreeFolder = { type: 'folder', name: '', path: '', children: [] };
  for (const file of files) {
    const segments = file.path.split('/');
    let folder = root;
    segments.slice(0, -1).forEach((name, index) => {
      const path = segments.slice(0, index + 1).join('/');
      let next = folder.children.find(
        (entry): entry is FileTreeFolder => entry.type === 'folder' && entry.name === name,
      );
      if (!next) {
        next = { type: 'folder', name, path, children: [] };
        folder.children.push(next);
      }
      folder = next;
    });
    folder.children.push({ type: 'file', name: segments.at(-1)!, path: file.path, file });
  }
  const sort = (entries: FileTreeEntry[]) => {
    entries.sort(byName);
    for (const entry of entries) if (entry.type === 'folder') sort(entry.children);
  };
  sort(root.children);
  return root.children;
}

/** Short type label of the mockup ("TEX", "BIB", "IMG"…). */
export function fileTypeLabel(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (['png', 'jpg', 'jpeg', 'eps'].includes(extension)) return 'IMG';
  if (['txt', 'md'].includes(extension)) return 'TXT';
  if (['sty', 'cls'].includes(extension)) return 'STY';
  return extension.toUpperCase();
}
