/**
 * Minimal tar (ustar with pax headers) for the files exchanged with the compilation sandbox:
 * written for its stdin, read from its stdout. Only regular files exist here; reading refuses
 * links, devices and directories, so nothing read from a sandbox can point outside its data.
 */

export interface TarEntry {
  name: string;
  data: Uint8Array;
}

const BLOCK = 512;

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

function header(name: string, size: number, type: '0' | 'x'): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, 'utf8');
  block.write(octal(0o600, 8), 100, 'ascii');
  block.write(octal(0, 8), 108, 'ascii');
  block.write(octal(0, 8), 116, 'ascii');
  block.write(octal(size, 12), 124, 'ascii');
  block.write(octal(0, 12), 136, 'ascii');
  block.write('        ', 148, 'ascii');
  block.write(type, 156, 'ascii');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return block;
}

const padding = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

/** A pax record "<length> <key>=<value>\n", the length counting itself. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length++;
  return `${length}${body}`;
}

/** Archive of regular files. Names longer than ustar allows, or not ASCII, go in a pax header. */
export function writeTar(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const { name, data } of entries) {
    if (Buffer.byteLength(name) > 99 || /[^\x20-\x7e]/.test(name)) {
      const pax = Buffer.from(paxRecord('path', name), 'utf8');
      parts.push(header('PaxHeader', pax.length, 'x'), pax, padding(pax.length));
    }

    parts.push(header(name.replace(/[^\x20-\x7e]/g, '_').slice(0, 99), data.length, '0'));
    parts.push(Buffer.from(data.buffer, data.byteOffset, data.length), padding(data.length));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

export class TarError extends Error {}

function field(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString('utf8');
}

function parseOctal(block: Buffer, offset: number, length: number): number {
  const text = field(block, offset, length).trim();
  if (!/^[0-7]+$/.test(text)) throw new TarError('Invalid number in tar header');
  return parseInt(text, 8);
}

function parsePax(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) throw new TarError('Invalid pax header');
    const length = Number(data.subarray(at, space).toString('ascii'));
    if (!Number.isInteger(length) || length <= 0 || at + length > data.length) {
      throw new TarError('Invalid pax record');
    }
    const record = data.subarray(space + 1, at + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1));
    at += length;
  }
  return records;
}

/**
 * Regular files of an archive. Anything else (link, directory, device) fails the whole read, as
 * does a corrupted header, more than `maxEntries` files or a file over `maxEntryBytes`.
 */
export function readTar(
  archive: Buffer,
  limits: { maxEntries: number; maxEntryBytes: number },
): TarEntry[] {
  const entries: TarEntry[] = [];
  let at = 0;
  let pax: Map<string, string> | null = null;
  while (at + BLOCK <= archive.length) {
    const block = archive.subarray(at, at + BLOCK);
    if (block.every((byte) => byte === 0)) return entries;
    let sum = 0;
    for (let index = 0; index < BLOCK; index++) {
      sum += index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
    }
    if (sum !== parseOctal(block, 148, 8)) throw new TarError('Bad tar checksum');
    const type = String.fromCharCode(block[156] ?? 0);
    let size = parseOctal(block, 124, 12);
    const paxSize = pax?.get('size');
    if (paxSize !== undefined) size = Number(paxSize);
    if (!Number.isSafeInteger(size) || size < 0) throw new TarError('Invalid tar entry size');
    const start = at + BLOCK;
    const end = start + size;
    if (end > archive.length) throw new TarError('Truncated tar archive');
    at = start + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'x' || type === 'g') {
      if (size > 64 * 1024) throw new TarError('Pax header too large');
      // Global headers ('g') hold nothing used here.
      if (type === 'x') pax = parsePax(archive.subarray(start, end));
      continue;
    }
    if (type !== '0' && type !== '\0') throw new TarError(`Refused tar entry type "${type}"`);
    if (size > limits.maxEntryBytes) throw new TarError('Tar entry too large');
    if (entries.length >= limits.maxEntries) throw new TarError('Too many tar entries');
    const prefix = field(block, 345, 155);
    const name = pax?.get('path') ?? (prefix ? `${prefix}/` : '') + field(block, 0, 100);
    pax = null;
    entries.push({ name, data: archive.subarray(start, end) });
  }
  throw new TarError('Tar archive without end marker');
}
