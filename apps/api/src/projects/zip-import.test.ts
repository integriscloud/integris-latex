import { MAX_PROJECT_FILE_BYTES } from '@integris/shared';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { checkContent } from './file-content.js';
import {
  guessMainFile,
  MAX_REPORTED,
  readProjectZip,
  type ZipLimits,
  ZipError,
} from './zip-import.js';

const MIB = 1024 * 1024;
const LIMITS: ZipLimits = {
  maxFiles: 2000,
  maxTotalBytes: 200 * MIB,
  maxFileBytes: MAX_PROJECT_FILE_BYTES,
  maxRatio: 100,
  ratioMinBytes: MIB,
  storageLeftBytes: 100 * MIB,
};

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const MAIN = strToU8('\\documentclass{article}\n\\begin{document}\nBonjour\n\\end{document}\n');

const zip = (files: Zippable) => zipSync(files);

const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    if (error instanceof ZipError) return error.code;
    throw error;
  }
  return null;
};

/** Sets a flag bit on every central directory entry (e.g. "encrypted"). */
function setCentralFlag(archive: Uint8Array, flag: number): Uint8Array {
  const copy = archive.slice();
  const view = new DataView(copy.buffer);
  for (let offset = 0; offset < copy.length - 4; offset++) {
    if (view.getUint32(offset, true) === 0x02014b50) {
      view.setUint16(offset + 8, view.getUint16(offset + 8, true) | flag, true);
    }
  }
  return copy;
}

/**
 * Hand-made archive: one local record per `locals` item, and central entries that may point at
 * any local record and declare any compressed size (what a hostile archive does).
 */
function craft(
  locals: { name: string; payload: Uint8Array }[],
  centrals: { name: string; local: number; size?: number }[],
): Uint8Array {
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;
  for (const { name, payload } of locals) {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt16LE(Buffer.byteLength(name), 26);
    offsets.push(offset);
    parts.push(header, Buffer.from(name), Buffer.from(payload));
    offset += 30 + Buffer.byteLength(name) + payload.length;
  }
  const directory: Buffer[] = [];
  for (const { name, local, size } of centrals) {
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(size ?? locals[local]!.payload.length, 20);
    entry.writeUInt16LE(Buffer.byteLength(name), 28);
    entry.writeUInt32LE(offsets[local]!, 42);
    directory.push(entry, Buffer.from(name));
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length, 8);
  end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, central, end]);
}

describe('readProjectZip', () => {
  it('reads a hand-made archive', async () => {
    const archive = craft(
      [{ name: 'a.tex', payload: deflateRawSync('hello') }],
      [{ name: 'a.tex', local: 0 }],
    );
    const result = await readProjectZip(archive, LIMITS);
    expect(new TextDecoder().decode(result.files[0]!.bytes)).toBe('hello');
  });

  it('refuses data hidden after the end of a compressed stream, quickly', async () => {
    const payload = Buffer.concat([deflateRawSync('hello'), Buffer.alloc(8 * MIB)]);
    const archive = craft([{ name: 'a.tex', payload }], [{ name: 'a.tex', local: 0 }]);
    const started = Date.now();
    expect(await codeOf(() => readProjectZip(archive, LIMITS))).toBe('archive_invalid');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('refuses entries sharing the same data', async () => {
    const archive = craft(
      [{ name: 'a.tex', payload: deflateRawSync('hello') }],
      [
        { name: 'a.tex', local: 0 },
        { name: 'b.tex', local: 0 },
      ],
    );
    expect(await codeOf(() => readProjectZip(archive, LIMITS))).toBe('archive_unsafe');
  });

  it('refuses a declared size running into the next entry', async () => {
    const one = deflateRawSync('one');
    const archive = craft(
      [
        { name: 'a.tex', payload: one },
        { name: 'b.tex', payload: deflateRawSync('two') },
      ],
      [
        { name: 'a.tex', local: 0, size: one.length + 40 },
        { name: 'b.tex', local: 1 },
      ],
    );
    expect(await codeOf(() => readProjectZip(archive, LIMITS))).toBeTruthy();
  });

  it('caps the report of files left out', async () => {
    const files: Zippable = { 'main.tex': MAIN };
    for (let index = 0; index < MAX_REPORTED + 5; index++) files[`x${index}.sh`] = strToU8('x');
    const result = await readProjectZip(zip(files), { ...LIMITS, maxFiles: 1000 });
    expect(result.skipped).toHaveLength(MAX_REPORTED);
    expect(result.skippedCount).toBe(MAX_REPORTED + 5);
  });

  it('keeps the allowed files and reports the others', async () => {
    const result = await readProjectZip(
      zip({
        'main.tex': MAIN,
        'figures/logo.PNG': PNG,
        'refs.bib': strToU8('@book{x, title={T}}'),
        latexmkrc: strToU8('$pdf_mode = 1;'),
        'build/main.zip': zip({ 'a.tex': MAIN }),
        'fake.png': strToU8('not an image'),
        'latin1.tex': new Uint8Array([0x63, 0x61, 0x66, 0xe9]),
      }),
      LIMITS,
    );
    expect(result.files.map((file) => [file.path, file.kind])).toEqual([
      ['main.tex', 'TEXT'],
      ['figures/logo.PNG', 'BINARY'],
      ['refs.bib', 'TEXT'],
    ]);
    expect(result.skipped).toEqual([
      { path: 'latexmkrc', reason: 'extension_not_allowed' },
      { path: 'build/main.zip', reason: 'nested_archive' },
      { path: 'fake.png', reason: 'type_mismatch' },
      { path: 'latin1.tex', reason: 'invalid_encoding' },
    ]);
  });

  it('removes a single wrapping folder and ignores system files', async () => {
    const result = await readProjectZip(
      zip({
        'these/main.tex': MAIN,
        'these/chapitres/intro.tex': strToU8('Intro'),
        '__MACOSX/these/._main.tex': strToU8('x'),
        'these/.DS_Store': strToU8('x'),
      }),
      LIMITS,
    );
    expect(result.files.map((file) => file.path)).toEqual(['main.tex', 'chapitres/intro.tex']);
    expect(result.skipped).toEqual([]);
  });

  it.each(['../evil.tex', '/etc/evil.tex', 'a/../../evil.tex', 'C:/evil.tex', '..\\evil.tex'])(
    'refuses the whole archive for the path %j',
    async (path) => {
      expect(
        await codeOf(() => readProjectZip(zip({ 'main.tex': MAIN, [path]: MAIN }), LIMITS)),
      ).toBe('archive_unsafe');
    },
  );

  it('refuses symbolic links', async () => {
    const link = zipSync({
      'main.tex': MAIN,
      'link.tex': [strToU8('/etc/passwd'), { os: 3, attrs: (0o120777 << 16) >>> 0 }],
    });
    expect(await codeOf(() => readProjectZip(link, LIMITS))).toBe('archive_unsafe');
  });

  it('refuses encrypted archives', async () => {
    const encrypted = setCentralFlag(zip({ 'main.tex': MAIN }), 0x1);
    expect(await codeOf(() => readProjectZip(encrypted, LIMITS))).toBe('archive_encrypted');
  });

  it('refuses damaged archives and files that are not ZIP', async () => {
    expect(await codeOf(() => readProjectZip(strToU8('hello'), LIMITS))).toBe('archive_invalid');
    const archive = zip({ 'main.tex': MAIN });
    expect(
      await codeOf(() => readProjectZip(archive.subarray(0, archive.length - 30), LIMITS)),
    ).toBe('archive_invalid');
  });

  it('refuses too many entries before reading them', async () => {
    const files: Zippable = {};
    for (let index = 0; index < 6; index++) files[`f${index}.tex`] = MAIN;
    expect(await codeOf(() => readProjectZip(zip(files), { ...LIMITS, maxFiles: 5 }))).toBe(
      'archive_too_many_files',
    );
  });

  it('stops a ZIP bomb on the compression ratio, whatever the headers announce', async () => {
    const bomb = zip({ 'main.tex': new Uint8Array(5 * MIB).fill(0x20) });
    expect(await codeOf(() => readProjectZip(bomb, LIMITS))).toBe('archive_unsafe');
  });

  it('counts the real decompressed bytes against the archive budget', async () => {
    const text = strToU8(randomBytes(600 * 1024).toString('base64'));
    const archive = zip({ 'a.tex': text, 'b.tex': text });
    expect(
      await codeOf(() => readProjectZip(archive, { ...LIMITS, maxTotalBytes: text.length + 10 })),
    ).toBe('archive_too_big_uncompressed');
  });

  it('refuses an archive larger than the storage left', async () => {
    const text = strToU8(randomBytes(30 * 1024).toString('base64'));
    expect(
      await codeOf(() =>
        readProjectZip(zip({ 'a.tex': text }), { ...LIMITS, storageLeftBytes: 1000 }),
      ),
    ).toBe('storage_limit');
  });

  it('leaves out a file larger than 10 MB', async () => {
    const big = strToU8(randomBytes(8 * MIB).toString('base64'));
    const result = await readProjectZip(zip({ 'main.tex': MAIN, 'big.txt': big }), LIMITS);
    expect(result.skipped).toEqual([{ path: 'big.txt', reason: 'file_too_large' }]);
  });

  it('refuses an archive without any usable file', async () => {
    expect(await codeOf(() => readProjectZip(zip({ 'run.sh': strToU8('rm') }), LIMITS))).toBe(
      'archive_empty',
    );
  });
});

describe('guessMainFile', () => {
  const file = (path: string, text = '') => ({ path, kind: 'TEXT', bytes: strToU8(text) });

  it('prefers main.tex, then the shallowest document class', async () => {
    expect(guessMainFile([file('a.tex'), file('main.tex')])).toBe('main.tex');
    expect(
      guessMainFile([
        file('chap/x.tex', '\\documentclass{book}'),
        file('these.tex', '\\documentclass{report}'),
        file('intro.tex', '% \\documentclass{x}'),
      ]),
    ).toBe('these.tex');
    expect(guessMainFile([file('b.tex'), file('a.tex')])).toBe('a.tex');
    expect(guessMainFile([])).toBe('main.tex');
  });
});

describe('checkContent', () => {
  it('checks the real type against the extension', async () => {
    expect(checkContent('.png', PNG)).toEqual({ ok: true, kind: 'BINARY' });
    expect(checkContent('.jpg', PNG)).toEqual({ ok: false, reason: 'type_mismatch' });
    expect(checkContent('.jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toEqual({
      ok: true,
      kind: 'BINARY',
    });
    expect(checkContent('.pdf', strToU8('%PDF-1.7\n'))).toEqual({ ok: true, kind: 'BINARY' });
    expect(checkContent('.eps', strToU8('%!PS-Adobe-3.0 EPSF-3.0'))).toEqual({
      ok: true,
      kind: 'BINARY',
    });
    expect(checkContent('.pdf', strToU8('<html>'))).toEqual({ ok: false, reason: 'type_mismatch' });
    expect(checkContent('.tex', strToU8('Été'))).toEqual({ ok: true, kind: 'TEXT' });
    expect(checkContent('.tex', new Uint8Array())).toEqual({ ok: true, kind: 'TEXT' });
    expect(checkContent('.tex', PNG)).toEqual({ ok: false, reason: 'invalid_encoding' });
  });
});
