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

/**
 * Nested folders from flat paths ("chapitres/intro.tex") and the folders of the project, empty
 * ones included ("annexes"); folders first, then names.
 */
export function buildFileTree(
  files: readonly TreeFile[],
  folders: readonly string[] = [],
): FileTreeEntry[] {
  const root: FileTreeFolder = { type: 'folder', name: '', path: '', children: [] };
  const folderOf = (segments: string[]) => {
    let folder = root;
    segments.forEach((name, index) => {
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
    return folder;
  };
  for (const path of folders) folderOf(path.split('/'));
  for (const file of files) {
    const segments = file.path.split('/');
    const folder = folderOf(segments.slice(0, -1));
    folder.children.push({ type: 'file', name: segments.at(-1)!, path: file.path, file });
  }
  const sort = (entries: FileTreeEntry[]) => {
    entries.sort(byName);
    for (const entry of entries) if (entry.type === 'folder') sort(entry.children);
  };
  sort(root.children);
  return root.children;
}

/** Kind of icon shown for a file, from its extension. */
export type FileIconKind = 'text' | 'bibliography' | 'image' | 'pdf' | 'style';

export function fileIconKind(path: string): FileIconKind {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (['png', 'jpg', 'jpeg', 'eps'].includes(extension)) return 'image';
  if (extension === 'bib') return 'bibliography';
  if (extension === 'pdf') return 'pdf';
  if (['sty', 'cls'].includes(extension)) return 'style';
  return 'text';
}
