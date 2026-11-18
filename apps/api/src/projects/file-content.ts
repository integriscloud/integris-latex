import { isTextExtension, type ProjectExtension } from '@integris/shared';

export type ContentCheck =
  | { ok: true; kind: 'TEXT' | 'BINARY' }
  | { ok: false; reason: 'type_mismatch' | 'invalid_encoding' };

const startsWith = (bytes: Uint8Array, signature: readonly number[]) =>
  bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

// Signatures of the binary formats accepted in a project.
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const PDF = ascii('%PDF-');
const POSTSCRIPT = ascii('%!PS');
const DOS_EPS = [0xc5, 0xd0, 0xd3, 0xc6];

const BINARY_SIGNATURES: Record<string, readonly (readonly number[])[]> = {
  '.png': [PNG],
  '.jpg': [JPEG],
  '.jpeg': [JPEG],
  '.pdf': [PDF],
  '.eps': [POSTSCRIPT, DOS_EPS],
};

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Valid UTF-8 without NUL byte: what the editor can open. */
export function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    utf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks that the real content matches the extension (the name and the type sent by the browser
 * are never trusted): signature of the binary formats, valid UTF-8 for text files.
 */
export function checkContent(extension: ProjectExtension, bytes: Uint8Array): ContentCheck {
  if (isTextExtension(extension)) {
    return isUtf8Text(bytes)
      ? { ok: true, kind: 'TEXT' }
      : { ok: false, reason: 'invalid_encoding' };
  }
  const signatures = BINARY_SIGNATURES[extension] ?? [];
  return signatures.some((signature) => startsWith(bytes, signature))
    ? { ok: true, kind: 'BINARY' }
    : { ok: false, reason: 'type_mismatch' };
}

const ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar'];
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

/** An archive inside an archive: refused during a ZIP import. */
export function isNestedArchive(extension: string | null, bytes?: Uint8Array): boolean {
  return (
    (extension !== null && ARCHIVE_EXTENSIONS.includes(extension)) ||
    (bytes !== undefined && startsWith(bytes, ZIP_SIGNATURE))
  );
}
