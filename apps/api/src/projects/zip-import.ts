import {
  allowedExtensionOf,
  extensionOf,
  normalizeFilePath,
  normalizeProjectPath,
  PATH_LIMITS,
  pathConflicts,
  projectFolders,
  type ProjectErrorCode,
  type SkippedFile,
} from '@integris/shared';
import { promisify } from 'node:util';
import { inflateRaw } from 'node:zlib';
import { checkContent, isNestedArchive } from './file-content.js';

/** Limits of one ZIP import (environment, file size of docs/spec.md and remaining quota). */
export interface ZipLimits {
  maxFiles: number;
  /** Bytes produced by decompression, for every entry, kept or not. */
  maxTotalBytes: number;
  maxFileBytes: number;
  maxRatio: number;
  ratioMinBytes: number;
  /** Bytes the kept files may take: what is left of the storage quota. */
  storageLeftBytes: number;
}

export interface ExtractedFile {
  path: string;
  bytes: Uint8Array;
  kind: 'TEXT' | 'BINARY';
}

export interface ZipImport {
  files: ExtractedFile[];
  /** Empty folders of the archive (directory entries holding no file kept). */
  folders: string[];
  /** Files left out, the first MAX_REPORTED of them (paths truncated). */
  skipped: SkippedFile[];
  skippedCount: number;
}

/** Lines of the report of files left out returned to the browser. */
export const MAX_REPORTED = 200;

/** The whole archive is refused. */
export class ZipError extends Error {
  constructor(readonly code: ProjectErrorCode) {
    super(code);
  }
}

interface Entry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  localOffset: number;
  nameLength: number;
  symlink: boolean;
}

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;
const FLAG_ENCRYPTED = 0x1;
const FLAG_UTF8 = 0x800;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const METHOD_AES = 99;
const HOST_UNIX = 3;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
/** Inflated data and the compressed bytes zlib actually consumed. */
interface InflateResult {
  buffer: Buffer;
  engine: { bytesWritten: number };
}

const inflate = promisify(
  (data: Uint8Array, options: object, done: (error: Error | null, result: InflateResult) => void) =>
    inflateRaw(data, { ...options, info: true }, done as never),
);

// System files added by archivers, ignored without a report line.
const IGNORED = [/^__MACOSX\//, /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/, /(^|\/)desktop\.ini$/i];

const invalid = () => new ZipError('archive_invalid');

/** Bounds-checked little-endian reader. */
class Reader {
  private readonly view: DataView;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private check(offset: number, size: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > this.bytes.length) {
      throw invalid();
    }
  }

  u16(offset: number): number {
    this.check(offset, 2);
    return this.view.getUint16(offset, true);
  }

  u32(offset: number): number {
    this.check(offset, 4);
    return this.view.getUint32(offset, true);
  }

  u64(offset: number): number {
    this.check(offset, 8);
    const value = this.view.getBigUint64(offset, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
    return Number(value);
  }

  slice(offset: number, size: number): Uint8Array {
    this.check(offset, size);
    return this.bytes.subarray(offset, offset + size);
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const latin1 = new TextDecoder('latin1');

function decodeName(raw: Uint8Array, flags: number): string {
  if (flags & FLAG_UTF8) {
    try {
      return utf8.decode(raw);
    } catch {
      throw invalid();
    }
  }
  try {
    return utf8.decode(raw);
  } catch {
    return latin1.decode(raw);
  }
}

/** Central directory: the authoritative list of entries (local headers are not trusted). */
function readEntries(
  reader: Reader,
  maxFiles: number,
): { entries: Entry[]; directoryOffset: number } {
  const { bytes } = reader;
  let eocd = -1;
  for (
    let offset = bytes.length - 22;
    offset >= Math.max(0, bytes.length - 22 - MAX_U16);
    offset--
  ) {
    if (reader.u32(offset) === SIG_EOCD) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw invalid();
  // Archives split over several disks are not supported.
  if (reader.u16(eocd + 4) !== 0 || reader.u16(eocd + 6) !== 0) throw invalid();
  let count = reader.u16(eocd + 10);
  let offset = reader.u32(eocd + 16);
  if (count === MAX_U16 || offset === MAX_U32) {
    const locator = eocd - 20;
    if (locator < 0 || reader.u32(locator) !== SIG_ZIP64_LOCATOR) throw invalid();
    const zip64 = reader.u64(locator + 8);
    if (reader.u32(zip64) !== SIG_ZIP64_EOCD) throw invalid();
    count = reader.u64(zip64 + 32);
    offset = reader.u64(zip64 + 48);
  }
  // Every entry counts, folders included: checked before reading anything else.
  if (count > maxFiles) throw new ZipError('archive_too_many_files');
  const directoryOffset = offset;

  const entries: Entry[] = [];
  for (let index = 0; index < count; index++) {
    if (reader.u32(offset) !== SIG_CENTRAL) throw invalid();
    const madeBy = reader.u16(offset + 4);
    const flags = reader.u16(offset + 8);
    const method = reader.u16(offset + 10);
    let compressedSize = reader.u32(offset + 20);
    let uncompressedSize = reader.u32(offset + 24);
    const nameLength = reader.u16(offset + 28);
    const extraLength = reader.u16(offset + 30);
    const commentLength = reader.u16(offset + 32);
    const attributes = reader.u32(offset + 38);
    let localOffset = reader.u32(offset + 42);
    const name = decodeName(reader.slice(offset + 46, nameLength), flags);

    // ZIP64 extra field: 64-bit values of the fields saturated at 0xFFFFFFFF, in this order.
    let extra = offset + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = reader.u16(extra);
      const size = reader.u16(extra + 2);
      if (id === 0x0001) {
        let field = extra + 4;
        if (uncompressedSize === MAX_U32) {
          uncompressedSize = reader.u64(field);
          field += 8;
        }
        if (compressedSize === MAX_U32) {
          compressedSize = reader.u64(field);
          field += 8;
        }
        if (localOffset === MAX_U32) localOffset = reader.u64(field);
      }
      extra += 4 + size;
    }

    const symlink = madeBy >> 8 === HOST_UNIX && ((attributes >>> 16) & S_IFMT) === S_IFLNK;
    entries.push({ name, flags, method, compressedSize, localOffset, nameLength, symlink });
    offset = extraEnd + commentLength;
  }
  return { entries, directoryOffset };
}

/**
 * Compressed data of every entry, located through its local header, which must agree with the
 * central directory. The data of two entries never overlap and all lie before the directory: one
 * blob cannot be decompressed many times, and no entry hides extra bytes.
 */
function locateData(reader: Reader, entries: Entry[], directoryOffset: number): Uint8Array[] {
  const ranges = entries.map((entry, index) => {
    const at = entry.localOffset;
    if (reader.u32(at) !== SIG_LOCAL) throw invalid();
    const flags = reader.u16(at + 6);
    if (
      reader.u16(at + 8) !== entry.method ||
      (flags & FLAG_ENCRYPTED) !== (entry.flags & FLAG_ENCRYPTED) ||
      reader.u16(at + 26) !== entry.nameLength
    ) {
      throw invalid();
    }
    const start = at + 30 + entry.nameLength + reader.u16(at + 28);
    const end = start + entry.compressedSize;
    if (end > directoryOffset) throw invalid();
    return { index, at, start, end };
  });
  const sorted = [...ranges].sort((a, b) => a.at - b.at);
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index]!.at < sorted[index - 1]!.end) throw new ZipError('archive_unsafe');
  }
  return ranges.map(({ start, end }) => reader.slice(start, end - start));
}

/**
 * Decompresses an entry outside the event loop (zlib thread pool), counting the bytes really
 * produced: the sizes announced in the headers are never trusted. Returns null for a file over
 * `maxFileBytes`; throws when the archive budget is spent, the ratio is abnormal or compressed
 * bytes are left after the end of the stream.
 */
async function inflateEntry(
  data: Uint8Array,
  method: number,
  limits: ZipLimits,
  budget: { left: number },
): Promise<Uint8Array | null> {
  const spend = (produced: number) => {
    budget.left -= produced;
    if (budget.left < 0) throw new ZipError('archive_too_big_uncompressed');
    if (produced >= limits.ratioMinBytes && produced > data.length * limits.maxRatio) {
      throw new ZipError('archive_unsafe');
    }
  };

  if (method === METHOD_STORED) {
    if (data.length > limits.maxFileBytes) return null;
    spend(data.length);
    return data;
  }
  const cap = Math.min(limits.maxFileBytes, budget.left);
  let result: InflateResult;
  try {
    result = await inflate(data, { maxOutputLength: cap + 1 });
  } catch (error) {
    if ((error as { code?: string }).code !== 'ERR_BUFFER_TOO_LARGE') throw invalid();
    spend(cap + 1);
    return null;
  }
  // Bytes after the end of the deflate stream: a malformed or hostile entry.
  if (result.engine.bytesWritten !== data.length) throw invalid();
  spend(result.buffer.length);
  return new Uint8Array(result.buffer.buffer, result.buffer.byteOffset, result.buffer.length);
}

/** Normalizes an archive name; null for a path that tries to leave the project. */
function archivePath(name: string): string | null {
  const path = name.replaceAll('\\', '/');
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return null;
  if (path.split('/').some((segment) => segment === '..')) return null;
  return path;
}

/** Single top folder wrapping everything ("projet/main.tex"), removed from the paths. */
function commonRoot(paths: string[]): string {
  const first = paths[0]?.split('/')[0];
  if (!first || !paths.every((path) => path.startsWith(`${first}/`))) return '';
  return `${first}/`;
}

/**
 * Reads a ZIP archive of a project (Overleaf or Prism export). Refuses the whole archive when it
 * is damaged, encrypted, contains a link, an absolute or ".." path, too many entries or too much
 * data; files of a refused type, too large or of the wrong content are left out and listed.
 */
export async function readProjectZip(archive: Uint8Array, limits: ZipLimits): Promise<ZipImport> {
  const reader = new Reader(archive);
  const { entries, directoryOffset } = readEntries(reader, limits.maxFiles);

  for (const entry of entries) {
    if (entry.flags & FLAG_ENCRYPTED || entry.method === METHOD_AES) {
      throw new ZipError('archive_encrypted');
    }
    if (entry.symlink || archivePath(entry.name) === null) throw new ZipError('archive_unsafe');
    if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) throw invalid();
  }
  const data = locateData(reader, entries, directoryOffset);

  const named = entries
    .map((entry, index) => ({ entry, data: data[index]!, path: archivePath(entry.name)! }))
    .filter(({ path }) => !IGNORED.some((pattern) => pattern.test(path)));
  const fileEntries = named.filter(({ path }) => !path.endsWith('/'));
  const root = commonRoot(fileEntries.map(({ path }) => path));

  const budget = { left: limits.maxTotalBytes };
  let kept = 0;
  const seen = new Set<string>();
  const files: ExtractedFile[] = [];
  const skipped: SkippedFile[] = [];

  for (const { entry, data: compressed, path: fullPath } of fileEntries) {
    const shown = fullPath.slice(root.length);
    const skip = (reason: SkippedFile['reason']) => skipped.push({ path: shown, reason });
    const extension = extensionOf(shown);
    if (isNestedArchive(extension)) {
      skip('nested_archive');
      continue;
    }
    const allowed = allowedExtensionOf(shown);
    if (!allowed) {
      skip('extension_not_allowed');
      continue;
    }
    const path = normalizeFilePath(shown);
    if (!path) {
      skip('invalid_path');
      continue;
    }
    if (seen.has(path)) {
      skip('path_taken');
      continue;
    }
    const bytes = await inflateEntry(compressed, entry.method, limits, budget);
    if (!bytes) {
      skip('file_too_large');
      continue;
    }
    if (isNestedArchive(null, bytes)) {
      skip('nested_archive');
      continue;
    }
    const check = checkContent(allowed, bytes);
    if (!check.ok) {
      skip(check.reason);
      continue;
    }
    kept += bytes.length;
    if (kept > limits.storageLeftBytes) throw new ZipError('storage_limit');
    seen.add(path);
    files.push({ path, bytes, kind: check.kind });
  }

  // A file and a folder of the same name cannot both exist: the later one is left out.
  const accepted: ExtractedFile[] = [];
  const paths: string[] = [];
  for (const file of files) {
    const clash = paths.some(
      (other) => other.startsWith(`${file.path}/`) || file.path.startsWith(`${other}/`),
    );
    if (clash) {
      skipped.push({ path: file.path, reason: 'path_taken' });
      continue;
    }
    paths.push(file.path);
    accepted.push(file);
  }
  if (!accepted.length) throw new ZipError('archive_empty');

  // Directory entries: kept only when no file kept lies inside (the others exist anyway).
  const implied = new Set(projectFolders(paths, []));
  const folders: string[] = [];
  for (const { path: fullPath } of named) {
    if (!fullPath.endsWith('/') || !fullPath.startsWith(root)) continue;
    const folder = normalizeProjectPath(fullPath.slice(root.length, -1));
    if (!folder || implied.has(folder) || folders.includes(folder)) continue;
    if (pathConflicts(paths, folder)) continue;
    folders.push(folder);
  }
  return {
    files: accepted,
    folders: folders.filter((folder) => !folders.some((other) => other.startsWith(`${folder}/`))),
    skipped: skipped.slice(0, MAX_REPORTED).map((file) => ({
      ...file,
      path: file.path.slice(0, PATH_LIMITS.maxLength),
    })),
    skippedCount: skipped.length,
  };
}

/**
 * Main file of an imported project: `main.tex` at the root, otherwise the shallowest `.tex` with
 * a `\documentclass`, otherwise the first `.tex`, otherwise `main.tex`.
 */
export function guessMainFile(
  files: readonly { path: string; kind: string; bytes?: Uint8Array }[],
) {
  const tex = files.filter((file) => extensionOf(file.path) === '.tex');
  if (tex.some((file) => file.path === 'main.tex')) return 'main.tex';
  const depth = (path: string) => path.split('/').length;
  const byDepth = [...tex].sort(
    (a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path),
  );
  const decoder = new TextDecoder();
  const withClass = byDepth.find(
    (file) => file.bytes && /^[^%\n]*\\documentclass/m.test(decoder.decode(file.bytes)),
  );
  return withClass?.path ?? byDepth[0]?.path ?? 'main.tex';
}
