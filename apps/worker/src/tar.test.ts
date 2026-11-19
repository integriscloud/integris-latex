import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTar, TarError, writeTar } from './tar.js';

const limits = { maxEntries: 100, maxEntryBytes: 1024 * 1024 };

describe('tar', () => {
  it('round-trips files, long and non-ASCII names included', () => {
    const long = `${'chapitres/'.repeat(12)}introduction-générale.tex`;
    const entries = [
      { name: 'main.tex', data: Buffer.from('\\documentclass{article}') },
      { name: long, data: Buffer.from('é'.repeat(700)) },
      { name: 'empty.tex', data: Buffer.alloc(0) },
    ];
    const read = readTar(writeTar(entries), limits);
    expect(read.map((entry) => entry.name)).toEqual(entries.map((entry) => entry.name));
    expect(Buffer.from(read[1]!.data).toString()).toBe('é'.repeat(700));
  });

  it('is read by GNU tar as the sandbox does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'integris-tar-'));
    try {
      const name = `${'dossier/'.repeat(14)}fichier.tex`;
      writeFileSync(join(dir, 'in.tar'), writeTar([{ name, data: Buffer.from('ok') }]));
      execFileSync('tar', ['-x', '-f', 'in.tar'], { cwd: dir });
      expect(readFileSync(join(dir, name), 'utf8')).toBe('ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the pax archives written by GNU tar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'integris-tar-'));
    try {
      writeFileSync(join(dir, 'main.pdf'), 'pdf');
      const archive = execFileSync('tar', ['-c', '-f', '-', '--format=pax', 'main.pdf'], {
        cwd: dir,
      });
      expect(readTar(archive, limits).map((entry) => entry.name)).toEqual(['main.pdf']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses links, oversized files and corrupted archives', () => {
    const dir = mkdtempSync(join(tmpdir(), 'integris-tar-'));
    try {
      symlinkSync('/etc/passwd', join(dir, 'link.tex'));
      const archive = execFileSync('tar', ['-c', '-f', '-', 'link.tex'], { cwd: dir });
      expect(() => readTar(archive, limits)).toThrow(TarError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const big = writeTar([{ name: 'big.aux', data: Buffer.alloc(2048) }]);
    expect(() => readTar(big, { maxEntries: 10, maxEntryBytes: 1024 })).toThrow(TarError);
    const many = writeTar([
      { name: 'a', data: Buffer.alloc(1) },
      { name: 'b', data: Buffer.alloc(1) },
    ]);
    expect(() => readTar(many, { maxEntries: 1, maxEntryBytes: 1024 })).toThrow(TarError);
    const corrupted = writeTar([{ name: 'a.tex', data: Buffer.from('x') }]);
    corrupted[0] = 0x41;
    expect(() => readTar(corrupted, limits)).toThrow(/checksum/);
    expect(() => readTar(corrupted.subarray(0, 600), limits)).toThrow(TarError);
  });
});
