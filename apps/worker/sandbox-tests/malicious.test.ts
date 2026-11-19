/**
 * Malicious suite (docs/spec.md, "Tests": run at every release): documents that try to read
 * files outside the project, write outside the working directory, run commands, reach the
 * network, loop forever, fill the disk or the memory. Each one goes through the real chain of
 * the worker (download by URL, gVisor sandbox, log reading) and must end cleanly, with a clear
 * outcome or message, and without leaking anything in the log or the PDF.
 *
 * Needs Docker, gVisor and the image (pnpm texlive:build). Run: pnpm test:malicious
 */
import type { CompileIssueId, CompileOutcome, EngineValue } from '@integris/shared';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SandboxHarness, SUITE_SECRET } from './harness.js';

/** What must never appear in an output: system file content, command output, worker secrets. */
const LEAKS = [/root:x?:0:0/, /daemon:x?:1:1/, /uid=\d+/, new RegExp(SUITE_SECRET)];

interface Case {
  name: string;
  engine: EngineValue;
  /** Plan duration given to the job (Free: 20 s). */
  seconds?: number;
  outcome: CompileOutcome;
  /** Issue that explains the failure to the user. */
  issue?: CompileIssueId;
  /** Text the document writes in the log when the attack was neutralized. */
  log?: string;
  /** Largest raw log kept. */
  maxLog?: number;
}

const CASES: Case[] = [
  // Reading outside the project.
  { name: 'read-etc-passwd', engine: 'PDFLATEX', outcome: 'tex_errors', issue: 'outside_project' },
  {
    name: 'read-parent-directory',
    engine: 'PDFLATEX',
    outcome: 'tex_errors',
    issue: 'outside_project',
  },
  {
    name: 'openin-etc-passwd',
    engine: 'PDFLATEX',
    outcome: 'success',
    log: 'ATTACK: nothing read',
  },
  { name: 'filedump-etc-passwd', engine: 'PDFLATEX', outcome: 'success', log: 'ATTACK: []' },
  {
    name: 'read-environment',
    engine: 'PDFLATEX',
    outcome: 'tex_errors',
    issue: 'invalid_character',
  },
  { name: 'lua-read-file', engine: 'LUALATEX', outcome: 'tex_errors', issue: 'outside_project' },
  { name: 'lua-unrestricted-lines', engine: 'LUALATEX', outcome: 'tex_errors', issue: 'lua_error' },
  // Writing outside the working directory.
  { name: 'write-outside', engine: 'PDFLATEX', outcome: 'tex_errors', issue: 'write_refused' },
  { name: 'write-parent', engine: 'PDFLATEX', outcome: 'tex_errors', issue: 'write_refused' },
  { name: 'dotfile-write', engine: 'PDFLATEX', outcome: 'tex_errors', issue: 'write_refused' },
  { name: 'lua-output', engine: 'LUALATEX', outcome: 'tex_errors', issue: 'lua_error' },
  // Commands.
  {
    name: 'write18-shell',
    engine: 'PDFLATEX',
    outcome: 'tex_errors',
    issue: 'shell_escape_refused',
  },
  {
    name: 'lua-execute',
    engine: 'LUALATEX',
    outcome: 'tex_errors',
    issue: 'system_command_refused',
  },
  { name: 'lua-ffi', engine: 'LUALATEX', outcome: 'tex_errors', issue: 'lua_module_unavailable' },
  {
    name: 'latexmkrc-injection',
    engine: 'PDFLATEX',
    outcome: 'success',
    log: 'ATTACK: no pwned.tex',
  },
  // Network.
  {
    name: 'network-write18',
    engine: 'PDFLATEX',
    outcome: 'tex_errors',
    issue: 'shell_escape_refused',
  },
  {
    name: 'network-lua-socket',
    engine: 'LUALATEX',
    outcome: 'tex_errors',
    issue: 'lua_module_unavailable',
  },
  // Resources.
  { name: 'infinite-loop', engine: 'PDFLATEX', seconds: 20, outcome: 'timeout' },
  { name: 'huge-file', engine: 'LUALATEX', seconds: 120, outcome: 'output_too_large' },
  { name: 'memory-bomb', engine: 'LUALATEX', seconds: 120, outcome: 'memory' },
  // The worker itself: a log too large to keep in memory, lines made to stall the log reader.
  {
    name: 'huge-log',
    engine: 'LUALATEX',
    seconds: 120,
    outcome: 'success',
    maxLog: 9 * 1024 * 1024,
  },
  { name: 'regex-bomb-log', engine: 'PDFLATEX', outcome: 'tex_errors', issue: 'tex_error' },
];

/** Text of a PDF: the strings of its content streams (inflated), enough to spot a leak. */
function pdfText(pdf: Buffer): string {
  const parts: string[] = [pdf.toString('latin1')];
  const raw = pdf.toString('latin1');
  for (const match of raw.matchAll(/stream\r?\n/g)) {
    const start = match.index + match[0].length;
    const end = raw.indexOf('endstream', start);
    if (end === -1) continue;
    try {
      const inflated = inflateSync(pdf.subarray(start, end)).toString('latin1');
      parts.push(
        inflated,
        [...inflated.matchAll(/\(((?:\\.|[^\\)])*)\)/g)].map((m) => m[1]).join(''),
      );
    } catch {
      // Not a Flate stream (fonts, images).
    }
  }
  return parts.join('\n');
}

describe('malicious suite', () => {
  const harness = new SandboxHarness();
  const report: string[] = [];

  beforeAll(() => harness.start());
  afterAll(() => {
    harness.stop();
    console.log(`\nMalicious suite\n${report.sort().join('\n')}\n`);
  });

  describe.concurrent.each(CASES)('$name', (test) => {
    it('fails cleanly without leaking anything', async () => {
      const source = await readFile(
        new URL(`malicious-cases/${test.name}/main.tex`, import.meta.url),
      );
      const { result, log, pdf } = await harness.compile(
        `suite-${test.name}`,
        new Map([['main.tex', source]]),
        { engine: test.engine, seconds: test.seconds ?? 60 },
      );
      const text = [log, pdf ? pdfText(pdf) : '', JSON.stringify(result.issues)].join('\n');
      const first = result.issues.find((issue) => issue.severity === 'error') ?? result.issues[0];
      report.push(
        [
          test.name.padEnd(24),
          test.engine.padEnd(9),
          result.outcome.padEnd(17),
          (first?.id ?? '-').padEnd(23),
          `${(result.durationMs / 1000).toFixed(1)} s`.padStart(7),
          ` ${(first?.raw ?? '').slice(0, 80)}`,
        ].join(' '),
      );
      expect(result.outcome).toBe(test.outcome);
      if (test.issue) expect(result.issues.map((issue) => issue.id)).toContain(test.issue);
      if (test.log) expect(text).toContain(test.log);
      for (const leak of LEAKS) expect(text).not.toMatch(leak);
      if (test.maxLog) expect(log.length).toBeLessThanOrEqual(test.maxLog);
    });
  });
});
