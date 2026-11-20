import type { User } from '@integris/db';
import type { Compilation, CompileResult } from '@integris/shared';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FilesServer } from '../files/files-server.js';
import { fileLinkKey, signFileLink, verifyFileLink } from '../files/file-links.js';
import { ORIGIN } from '../test/auth-app.js';
import { type CompileTestApp, createCompileTestApp } from '../test/compile-app.js';
import { TEST_USER_HEADER } from '../test/projects-app.js';
import { CompileService } from './compile.service.js';

const AUTH_SECRET = 'test-auth-secret-0123456789abcdef0123';
const FILES_URL = 'http://127.0.0.1:4100';

const success = (overrides: Partial<CompileResult> = {}): CompileResult => ({
  outcome: 'success',
  durationMs: 1800,
  issues: [],
  errorCount: 0,
  warningCount: 0,
  pdfBytes: 5,
  log: true,
  synctex: true,
  worker: 'worker-1',
  ...overrides,
});

describe('compile API', () => {
  let ctx: CompileTestApp;
  let owner: User;
  let editor: User;
  let viewer: User;
  let stranger: User;
  let projectId: string;

  const as = (user: User) => {
    const server = () => request(ctx.app.getHttpServer());
    return {
      get: (path: string) => server().get(`/api/projects/${path}`).set(TEST_USER_HEADER, user.id),
      post: (path: string, body: object = {}) =>
        server()
          .post(`/api/projects/${path}`)
          .set('Origin', ORIGIN)
          .set(TEST_USER_HEADER, user.id)
          .send(body),
    };
  };

  const compile = async (user: User, body: object = {}) =>
    (await as(user).post(`${projectId}/compile`, body).expect(201)).body as Compilation;

  /** A worker finishing the job: outputs in storage, then the "completed" event. */
  const finish = async (id: string, result: CompileResult) => {
    const prefix = `compile-output/${projectId}/${id}`;
    if (result.pdfBytes)
      await ctx.storage.put(
        'compile-output',
        `${projectId}/${id}/output.pdf`,
        Buffer.from('%PDF-'),
      );
    if (result.log)
      await ctx.storage.put(
        'compile-output',
        `${projectId}/${id}/output.log`,
        Buffer.from('This is pdfTeX'),
      );
    expect(prefix).toBeTruthy();
    await ctx.queue.handlers!.completed(id, result);
  };

  beforeAll(async () => {
    ctx = await createCompileTestApp({ FILES_PUBLIC_URL: FILES_URL });
  });

  beforeEach(async () => {
    ctx.db.reset();
    ctx.queue.reset();
    ctx.storage.objects.clear();
    await ctx.app.get(CompileService)['redis'].client.flushdb();
    owner = ctx.db.addUser('Awa Kaboré');
    editor = ctx.db.addUser('Issa Traoré');
    viewer = ctx.db.addUser('Encadrant');
    stranger = ctx.db.addUser('Inconnu');
    const project = await ctx.db.client.project.create({
      data: { ownerId: owner.id, name: 'Mémoire de master' },
    });
    projectId = project.id;
    await ctx.db.client.projectFile.create({
      data: {
        projectId,
        path: 'main.tex',
        kind: 'TEXT',
        storageKey: `${projectId}/k1`,
        sizeBytes: 40,
      },
    });
    await ctx.db.client.projectFile.create({
      data: {
        projectId,
        path: 'figures/bassin.png',
        kind: 'BINARY',
        storageKey: `${projectId}/k2`,
        sizeBytes: 900,
      },
    });
    ctx.db.share(projectId, editor.id, 'EDITOR');
    ctx.db.share(projectId, viewer.id, 'SUPERVISOR');
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  describe('starting', () => {
    it('queues a job with presigned GET URLs of 5 minutes and the quotas of the owner plan', async () => {
      const compilation = await compile(owner);
      expect(compilation).toMatchObject({
        status: 'QUEUED',
        position: 1,
        maxSeconds: 20,
        pdf: null,
      });
      const job = ctx.queue.jobs.get(compilation.id)!;
      // Free plan: low priority (BullMQ rank 3), 20 s.
      expect(job.priority).toBe(3);
      expect(job.data).toMatchObject({
        projectId,
        engine: 'PDFLATEX',
        mainFile: 'main.tex',
        timeoutSeconds: 20,
      });
      expect(job.data.files.map((file) => [file.path, file.size])).toEqual([
        ['figures/bassin.png', 900],
        ['main.tex', 40],
      ]);
      for (const file of job.data.files) {
        expect(file.url).toMatch(/^http:\/\/127\.0\.0\.1:9000\/projects\/.+X-Amz-Expires=300/);
      }
      const row = ctx.db.compilations[0]!;
      expect(row).toMatchObject({
        triggeredById: owner.id,
        chargedUserId: owner.id,
        priority: 'LOW',
      });
    });

    it('lets editors compile, charged to the owner, with the best plan of the owner', async () => {
      ctx.db.personalPlans.set(owner.id, 'STANDARD');
      Object.assign(
        ctx.db.plans.find((plan) => plan.code === 'STANDARD')!,
        {
          compilePriority: 'NORMAL',
          maxCompileSeconds: 120,
        },
      );
      const compilation = await compile(editor);
      expect(compilation.maxSeconds).toBe(120);
      expect(ctx.queue.jobs.get(compilation.id)!.priority).toBe(2);
      expect(ctx.db.compilations[0]).toMatchObject({
        triggeredById: editor.id,
        chargedUserId: owner.id,
      });
    });

    it('refuses other roles, strangers and read-only projects', async () => {
      await as(viewer).post(`${projectId}/compile`).expect(403, { code: 'forbidden' });
      await as(stranger).post(`${projectId}/compile`).expect(404, { code: 'not_found' });
      ctx.db.projects[0]!.readOnlyReason = 'OVER_FREE_LIMIT';
      await as(owner).post(`${projectId}/compile`).expect(403, { code: 'read_only' });
      expect(ctx.queue.jobs.size).toBe(0);
    });

    it('refuses automatic compilation on the Free plan only', async () => {
      await as(owner)
        .post(`${projectId}/compile`, { auto: true })
        .expect(403, { code: 'auto_compile_unavailable' });
      ctx.db.personalPlans.set(owner.id, 'STANDARD');
      ctx.db.plans.find((plan) => plan.code === 'STANDARD')!.autoCompile = true;
      await compile(owner, { auto: true });
    });

    it('needs a .tex main file', async () => {
      ctx.db.projects[0]!.mainFilePath = 'absent.tex';
      await as(owner).post(`${projectId}/compile`).expect(422, { code: 'main_missing' });
    });

    it('replaces a compilation still waiting, which is not charged', async () => {
      const first = await compile(owner);
      const second = await compile(editor);
      expect(ctx.db.compilations.find((row) => row.id === first.id)?.status).toBe('CANCELED');
      expect([...ctx.queue.jobs.keys()]).toEqual([second.id]);
      const state = (await as(owner).get(`${projectId}/compile`).expect(200)).body;
      expect(state.current.id).toBe(second.id);
    });

    it('blocks over the hourly quota of the owner with a clear code and a delay', async () => {
      ctx.db.plans.find((plan) => plan.code === 'FREE')!.maxCompilesPerHour = 2;
      for (let index = 0; index < 2; index++) {
        const compilation = await compile(owner);
        await finish(compilation.id, success());
      }
      const refused = await as(editor).post(`${projectId}/compile`).expect(429);
      expect(refused.body.code).toBe('compile_limit');
      expect(refused.body.retryAfter).toBeGreaterThan(3500);
    });
  });

  describe('results', () => {
    it('stores the result and gives every role a signed link on the files domain', async () => {
      const { id } = await compile(owner);
      await ctx.queue.handlers!.active(id);
      expect((await as(owner).get(`${projectId}/compilations/${id}`).expect(200)).body.status).toBe(
        'RUNNING',
      );
      await finish(
        id,
        success({
          warningCount: 1,
          issues: [
            {
              id: 'undefined_reference',
              severity: 'warning',
              file: 'main.tex',
              line: 3,
              args: { label: 'fig' },
              raw: 'x',
            },
          ],
        }),
      );

      const view = (await as(viewer).get(`${projectId}/compilations/${id}`).expect(200))
        .body as Compilation;
      expect(view).toMatchObject({
        status: 'SUCCEEDED',
        outcome: 'success',
        durationMs: 1800,
        log: true,
        synctex: true,
        warningCount: 1,
      });
      expect(view.pdf!.url).toMatch(new RegExp(`^${FILES_URL}/pdf/[^/]+/Memoire-de-master\\.pdf$`));
      const token = view.pdf!.url.split('/')[4]!;
      const link = verifyFileLink(fileLinkKey(AUTH_SECRET), token);
      expect(link).toMatchObject({ key: `${projectId}/${id}/output.pdf`, download: false });
      // 15 minutes (docs/spec.md).
      expect(link!.expires * 1000 - Date.now()).toBeGreaterThan(14 * 60_000);
      expect(ctx.queue.jobs.has(id)).toBe(false);

      // The plan of the owner is told to the owner and editors only, never to the other roles.
      expect(view.maxSeconds).toBeNull();
      const state = (await as(viewer).get(`${projectId}/compile`).expect(200)).body;
      expect(state).toMatchObject({
        canCompile: false,
        autoCompile: false,
        maxSeconds: null,
        maxPerHour: null,
      });
      expect(state.lastPdf.maxSeconds).toBeNull();
      expect((await as(owner).get(`${projectId}/compile`)).body).toMatchObject({
        maxSeconds: 20,
        maxPerHour: 30,
      });
      expect(state.lastPdf.id).toBe(id);
      await as(stranger).get(`${projectId}/compile`).expect(404);
    });

    it('serves the raw log as inert text, to project members only', async () => {
      const { id } = await compile(owner);
      await finish(id, success());
      const log = await as(viewer).get(`${projectId}/compilations/${id}/log`).expect(200);
      expect(log.text).toBe('This is pdfTeX');
      expect(log.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(log.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
      expect(log.headers['x-content-type-options']).toBe('nosniff');
      await as(stranger).get(`${projectId}/compilations/${id}/log`).expect(404);
    });

    it('keeps the last PDF when the next compilation fails, and drops older outputs', async () => {
      const first = await compile(owner);
      await finish(first.id, success());
      const second = await compile(owner);
      await finish(second.id, success());
      const third = await compile(owner);
      await finish(third.id, success({ outcome: 'tex_errors', pdfBytes: null, errorCount: 1 }));

      const state = (await as(owner).get(`${projectId}/compile`).expect(200)).body;
      expect(state.current).toMatchObject({
        id: third.id,
        status: 'FAILED',
        outcome: 'tex_errors',
        pdf: null,
      });
      expect(state.lastPdf.id).toBe(second.id);
      expect([...ctx.storage.objects.keys()].filter((key) => key.includes(first.id))).toEqual([]);
      expect(ctx.storage.objects.has(`compile-output/${projectId}/${second.id}/output.pdf`)).toBe(
        true,
      );
    });

    it('maps outcomes to statuses and finishes a compilation once', async () => {
      const { id } = await compile(owner);
      await ctx.queue.handlers!.completed(
        id,
        success({ outcome: 'timeout', pdfBytes: null, log: false }),
      );
      await ctx.queue.handlers!.completed(id, success());
      expect(ctx.db.compilations[0]).toMatchObject({ status: 'TIMED_OUT', pdfKey: null });
      const crashed = await compile(owner);
      await ctx.queue.handlers!.failed(crashed.id);
      const view = (await as(owner).get(`${projectId}/compilations/${crashed.id}`).expect(200))
        .body;
      expect(view).toMatchObject({ status: 'FAILED', outcome: 'internal' });
    });

    it('finishes a compilation whose event was missed when it is read', async () => {
      const { id } = await compile(owner);
      Object.assign(ctx.queue.jobs.get(id)!, { state: 'completed', result: success() });
      const view = (await as(owner).get(`${projectId}/compilations/${id}`).expect(200)).body;
      expect(view.status).toBe('SUCCEEDED');
    });
  });

  it('renews the URLs of jobs still waiting before they expire', async () => {
    const { id } = await compile(owner);
    const job = ctx.queue.jobs.get(id)!;
    job.data.signedAt -= 200_000;
    const renewed = await ctx.app.get(CompileService).renewUrls();
    expect(renewed).toBe(1);
    expect(job.data.signedAt).toBeGreaterThan(Date.now() - 5000);
    expect(job.data.files).toHaveLength(2);
  });

  it('never signs URLs for a job forged or edited in Redis (worker side)', async () => {
    const other = await ctx.db.client.project.create({
      data: { ownerId: stranger.id, name: 'Autre' },
    });
    await ctx.db.client.projectFile.create({
      data: {
        projectId: other.id,
        path: 'secret.tex',
        kind: 'TEXT',
        storageKey: `${other.id}/s`,
        sizeBytes: 9,
      },
    });
    // A job without any Compilation row.
    await ctx.queue.add(
      {
        compilationId: 'forged',
        projectId: other.id,
        engine: 'PDFLATEX',
        mainFile: 'secret.tex',
        cache: true,
        timeoutSeconds: 999,
        files: [],
        signedAt: 0,
      },
      1,
    );
    // A real queued job retargeted at the other project.
    const { id } = await compile(owner);
    const job = ctx.queue.jobs.get(id)!;
    Object.assign(job.data, { projectId: other.id, timeoutSeconds: 999, signedAt: 0 });
    expect(await ctx.app.get(CompileService).renewUrls()).toBe(1);
    expect(ctx.queue.jobs.get('forged')!.data.files).toEqual([]);
    expect(job.data).toMatchObject({ projectId, timeoutSeconds: 20 });
    expect(job.data.files.map((file) => file.path)).toEqual(['figures/bassin.png', 'main.tex']);
  });

  it('changes the engine of the project (owner and editor), which the next job uses', async () => {
    const patch = (user: User) =>
      request(ctx.app.getHttpServer())
        .patch(`/api/projects/${projectId}`)
        .set('Origin', ORIGIN)
        .set(TEST_USER_HEADER, user.id)
        .send({ engine: 'LUALATEX' });
    await patch(viewer).expect(403);
    expect((await patch(editor).expect(200)).body.engine).toBe('LUALATEX');
    const { id } = await compile(owner);
    expect(ctx.queue.jobs.get(id)!.data.engine).toBe('LUALATEX');
  });
});

describe('files domain', () => {
  const key = fileLinkKey(AUTH_SECRET);
  let server: Server;
  let base = '';
  const objects = new Map<string, Buffer>([['p1/c1/output.pdf', Buffer.from('%PDF-1.5 test')]]);

  beforeAll(async () => {
    const files = new FilesServer(
      { env: { AUTH_SECRET, WEB_ORIGINS: [ORIGIN] } } as never,
      {
        open: async (_bucket: string, objectKey: string) => {
          const body = objects.get(objectKey);
          const { Readable } = await import('node:stream');
          return body
            ? { body: Readable.from([body]), size: body.length, encoding: undefined }
            : null;
        },
      } as never,
    );
    server = createServer((req, res) => void files.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const token = (overrides: Partial<{ key: string; expires: number; download: boolean }> = {}) =>
    signFileLink(key, {
      key: 'p1/c1/output.pdf',
      expires: Math.floor(Date.now() / 1000) + 900,
      download: false,
      ...overrides,
    });

  it('serves a signed PDF with the headers of user content, and CORS for the app only', async () => {
    const response = await request(base)
      .get(`/pdf/${token()}/memoire.pdf`)
      .set('Origin', ORIGIN)
      .expect(200);
    expect(response.body.toString()).toBe('%PDF-1.5 test');
    expect(response.headers).toMatchObject({
      'content-type': 'application/pdf',
      'content-security-policy':
        "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      'x-content-type-options': 'nosniff',
      'content-disposition': 'inline; filename="memoire.pdf"',
      'access-control-allow-origin': ORIGIN,
    });
    expect(response.headers['set-cookie']).toBeUndefined();
    const other = await request(base)
      .get(`/pdf/${token()}/memoire.pdf`)
      .set('Origin', 'https://evil.example')
      .expect(200);
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
    const download = await request(base)
      .get(`/pdf/${token({ download: true })}/memoire.pdf`)
      .expect(200);
    expect(download.headers['content-disposition']).toBe('attachment; filename="memoire.pdf"');
  });

  it('refuses forged, expired, foreign and malformed links', async () => {
    const [payload, signature] = token().split('.');
    const forged = `${Buffer.from(JSON.stringify({ k: 'p2/c9/output.pdf', e: 9999999999, d: 0 })).toString('base64url')}.${signature}`;
    for (const path of [
      `/pdf/${forged}/a.pdf`,
      `/pdf/${payload}.${signature!.slice(1)}x/a.pdf`,
      `/pdf/${token({ expires: Math.floor(Date.now() / 1000) - 1 })}/a.pdf`,
      `/pdf/${token({ key: 'p1/c1/output.log' })}/a.pdf`,
      `/pdf/${token({ key: 'p1/c2/output.pdf' })}/a.pdf`,
      `/pdf/${token()}/../../etc/passwd`,
      '/api/projects',
      '/',
    ]) {
      const response = await request(base).get(path);
      expect(response.status, path).toBe(404);
      expect(response.headers['content-security-policy']).toContain('sandbox');
    }
    await request(base).post(`/pdf/${token()}/a.pdf`).expect(405);
  });
});
