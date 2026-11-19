import { type CompileJob, parseEnv, workerEnvSchema } from '@integris/shared';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { compile, type CompileDependencies } from './compile.js';
import type { SandboxRequest, SandboxRun } from './sandbox.js';
import { readTar, writeTar } from './tar.js';

const LOG = `This is pdfTeX
(./main.tex
./main.tex:12: Undefined control sequence.
l.12 Voir la \\fgure
                    ~\\ref{x}.
)
Output written on main.pdf (1 page, 1000 bytes).`;

describe('compile', () => {
  let server: Server;
  let origin = '';
  let stored: Map<string, Buffer>;
  let requests: SandboxRequest[];
  let next: SandboxRun;

  beforeAll(async () => {
    server = createServer((request, response) =>
      request.url === '/expired'
        ? response.writeHead(403).end()
        : response.writeHead(200).end('\\begin{document}'),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());
  beforeEach(() => {
    stored = new Map();
    requests = [];
  });

  const deps = (): CompileDependencies => ({
    env: parseEnv(workerEnvSchema, {
      REDIS_URL: 'redis://127.0.0.1:6379',
      MINIO_ENDPOINT: origin,
      MINIO_WORKER_ACCESS_KEY: 'test',
      MINIO_WORKER_SECRET_KEY: 'test-secret',
    }),
    storage: {
      get: async (bucket, key) => stored.get(`${bucket}/${key}`) ?? null,
      put: async (bucket, key, body) => void stored.set(`${bucket}/${key}`, Buffer.from(body)),
      delete: async (bucket, key) => void stored.delete(`${bucket}/${key}`),
    },
    runSandbox: async (_limits, request) => {
      requests.push(request);
      return next;
    },
    logger: pino({ level: 'silent' }),
    workerName: 'test-worker',
  });

  const job = (overrides: Partial<CompileJob> = {}): CompileJob => ({
    compilationId: 'c1',
    projectId: 'p1',
    engine: 'PDFLATEX',
    mainFile: 'main.tex',
    timeoutSeconds: 20,
    files: [{ path: 'main.tex', size: 16, url: `${origin}/main` }],
    ...overrides,
  });

  const finished = (
    files: Record<string, string | Buffer>,
    exitCode = 0,
    freeKb = 900_000,
  ): SandboxRun => ({
    kind: 'finished',
    exitCode,
    durationMs: 1500,
    freeKb,
    files: Object.entries(files).map(([name, data]) => ({
      name: `work/${name}`,
      data: Buffer.from(data),
    })),
  });

  it('stores the PDF, the log, the SyncTeX index and the cache of a successful compilation', async () => {
    next = finished({
      'main.pdf': '%PDF-1.5',
      'main.log': 'Output written on main.pdf (1 page, 8 bytes).',
      'main.synctex.gz': gzipSync(
        'SyncTeX Version:1\nInput:1:/work/./main.tex\nContent:\n{1\n(1,3:100,200:300,10,2\n)\n}1\n',
      ),
      'main.aux': '\\relax',
      'chapitres/intro.aux': '\\relax',
    });
    const result = await compile(deps(), job());
    expect(result).toMatchObject({
      outcome: 'success',
      pdfBytes: 8,
      log: true,
      synctex: true,
      worker: 'test-worker',
    });
    expect([...stored.keys()].sort()).toEqual([
      'compile-cache/p1/cache.tar',
      'compile-output/p1/c1/output.log',
      'compile-output/p1/c1/output.pdf',
      'compile-output/p1/c1/synctex.json.gz',
    ]);
    const cache = readTar(stored.get('compile-cache/p1/cache.tar')!, {
      maxEntries: 10,
      maxEntryBytes: 100,
    });
    expect(cache.map((entry) => entry.name).sort()).toEqual(['chapitres/intro.aux', 'main.aux']);
    expect(requests[0]).toMatchObject({ engine: 'PDFLATEX', mainFile: 'main.tex', seconds: 20 });
  });

  it('gives back the cache, never over a project file', async () => {
    stored.set(
      'compile-cache/p1/cache.tar',
      writeTar([
        { name: 'main.aux', data: Buffer.from('cached') },
        { name: 'main.tex', data: Buffer.from('not a cache file') },
        { name: '../evil.aux', data: Buffer.from('outside') },
      ]),
    );
    next = finished({ 'main.pdf': '%PDF', 'main.log': '' });
    await compile(deps(), job());
    const input = readTar(requests[0]!.input, { maxEntries: 10, maxEntryBytes: 1000 });
    expect(input.map((entry) => [entry.name, Buffer.from(entry.data).toString()])).toEqual([
      ['main.tex', '\\begin{document}'],
      ['main.aux', 'cached'],
    ]);
  });

  it('reports TeX errors with their file and line, keeps the PDF and drops the cache', async () => {
    stored.set('compile-cache/p1/cache.tar', writeTar([]));
    next = finished({ 'main.pdf': '%PDF', 'main.log': LOG, 'main.aux': 'x' }, 12);
    const result = await compile(deps(), job());
    expect(result.outcome).toBe('tex_errors');
    expect(result.issues[0]).toMatchObject({
      id: 'undefined_control_sequence',
      file: 'main.tex',
      line: 12,
      args: { command: '\\fgure' },
    });
    expect(result.pdfBytes).toBe(4);
    expect(stored.has('compile-cache/p1/cache.tar')).toBe(false);
  });

  it.each([
    [{ kind: 'timeout', durationMs: 20_000 } as SandboxRun, 'timeout'],
    [{ kind: 'memory', durationMs: 9000 } as SandboxRun, 'memory'],
    [{ kind: 'output_too_large', durationMs: 9000 } as SandboxRun, 'output_too_large'],
    [{ kind: 'failed', detail: 'docker' } as SandboxRun, 'internal'],
  ])('turns a cut run into a clear outcome (%#)', async (run, outcome) => {
    next = run;
    const result = await compile(deps(), job());
    expect(result).toMatchObject({ outcome, pdfBytes: null, issues: [] });
    expect([...stored.keys()]).toEqual([]);
  });

  it('sees a full working directory or an oversized PDF as output too large', async () => {
    next = finished({ 'main.pdf': '%PDF', 'main.log': '' }, 0, 100);
    expect((await compile(deps(), job())).outcome).toBe('output_too_large');
    expect(stored.has('compile-output/p1/c1/output.pdf')).toBe(false);
  });

  it('refuses a missing main file and invalid jobs before running anything', async () => {
    expect((await compile(deps(), job({ mainFile: 'absent.tex' }))).outcome).toBe('main_missing');
    expect((await compile(deps(), { compilationId: 'x' })).outcome).toBe('internal');
    expect(
      (
        await compile(
          deps(),
          job({ files: [{ path: '../x.tex', size: 1, url: `${origin}/x` }], mainFile: '../x.tex' }),
        )
      ).outcome,
    ).toBe('internal');
    expect(requests).toEqual([]);
  });

  it('reports expired links as unavailable sources, other bad files as internal', async () => {
    const expired = job({ files: [{ path: 'main.tex', size: 16, url: `${origin}/expired` }] });
    expect((await compile(deps(), expired)).outcome).toBe('sources_unavailable');
    const outside = job({ files: [{ path: 'main.tex', size: 16, url: 'http://127.0.0.1:1/x' }] });
    expect((await compile(deps(), outside)).outcome).toBe('internal');
    const resized = job({ files: [{ path: 'main.tex', size: 99, url: `${origin}/main` }] });
    expect((await compile(deps(), resized)).outcome).toBe('internal');
  });
});
