import type { User } from '@integris/db';
import { COLLAB_SECRET_HEADER, INTERNAL_PATHS } from '@integris/shared';
import { strToU8 } from 'fflate';
import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../auth/keys.js';
import { RedisService } from '../redis/redis.service.js';
import { ORIGIN } from '../test/auth-app.js';
import {
  createProjectsTestApp,
  type ProjectsTestApp,
  TEST_USER_HEADER,
} from '../test/projects-app.js';
import { PNG } from '../projects/zip-import.test.js';
import { CollabModule } from './collab.module.js';
import { InternalServer } from './internal-server.js';

const SECRET = 'test-collab-internal-secret-0123456789abcdef';

describe('internal API of the collaboration server', () => {
  let ctx: ProjectsTestApp;
  let internal: Server;
  let owner: User;
  let other: User;
  let projectId: string;
  let fileId: string;

  const call = (path: string, body: object, secret: string | null = SECRET) => {
    const req = request(internal).post(path);
    if (secret !== null) req.set(COLLAB_SECRET_HEADER, secret);
    return req.send(body);
  };

  /** A session as SessionService stores it; returns the cookie value. */
  const sessionOf = async (user: User) => {
    const id = `session-${user.id}`;
    const now = Math.floor(Date.now() / 1000);
    await ctx.app.get(RedisService).client.set(
      `sess:${sha256(id)}`,
      JSON.stringify({
        userId: user.id,
        spaceId: null,
        createdAt: now,
        absoluteExpiresAt: now + 3600,
      }),
      'EX',
      3600,
    );
    return id;
  };

  const authorize = async (user: User | null, file: string | null = fileId, project = projectId) =>
    (
      await call(INTERNAL_PATHS.authorize, {
        session: user ? await sessionOf(user) : 'nobody',
        projectId: project,
        fileId: file,
      }).expect(200)
    ).body;

  const load = () => call(INTERNAL_PATHS.load, { projectId, fileId });
  const store = (text: string, baseKey: string | null, state = 'AQID') =>
    call(INTERNAL_PATHS.store, { projectId, fileId, state, text, baseKey }).expect(200);
  const main = () => ctx.db.files.find((file) => file.id === fileId)!;
  const stored = () =>
    new TextDecoder().decode(ctx.storage.objects.get(`projects/${main().storageKey}`));

  beforeAll(async () => {
    ctx = await createProjectsTestApp({}, [CollabModule]);
    const server = ctx.app.get(InternalServer);
    internal = createServer((req, res) => void server.handle(req, res));
  });

  beforeEach(async () => {
    ctx.db.reset();
    ctx.storage.objects.clear();
    owner = ctx.db.addUser('Awa Kaboré');
    other = ctx.db.addUser('Issa Traoré');
    const created = await request(ctx.app.getHttpServer())
      .post('/api/projects')
      .set('Origin', ORIGIN)
      .set(TEST_USER_HEADER, owner.id)
      .send({ name: 'Mémoire' })
      .expect(201);
    projectId = created.body.id;
    fileId = ctx.db.files.find((file) => file.projectId === projectId)!.id;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('refuses calls without the shared secret', async () => {
    await call(INTERNAL_PATHS.authorize, {}, null).expect(401);
    await call(INTERNAL_PATHS.authorize, {}, 'wrong').expect(401);
    await call('/elsewhere', {}).expect(404);
    await call(INTERNAL_PATHS.authorize, { session: 1 }).expect(400);
  });

  it('applies the plan limits of users whose plan changed (development only, pnpm dev:plan)', async () => {
    ctx.db.personalPlans.set(owner.id, 'STANDARD');
    for (const name of ['B', 'C', 'D']) {
      await request(ctx.app.getHttpServer())
        .post('/api/projects')
        .set('Origin', ORIGIN)
        .set(TEST_USER_HEADER, owner.id)
        .send({ name })
        .expect(201);
    }
    // 4 projects created while holding STANDARD, then back to FREE (3 projects).
    ctx.db.personalPlans.delete(owner.id);
    ctx.db.projects[0]!.lastActivityAt = new Date(Date.now() - 86_400_000);
    const answer = await call(INTERNAL_PATHS.planChanged, { userIds: [owner.id] }).expect(200);
    expect(answer.body.changed[owner.id]).toEqual([projectId]);
    expect(ctx.db.projects[0]!.readOnlyReason).toBe('OVER_PLAN_LIMIT');
    expect(await authorize(owner)).toMatchObject({ ok: true, writable: false });
    await call(INTERNAL_PATHS.planChanged, { userIds: [] }).expect(400);

    const server = ctx.app.get(InternalServer) as unknown as { development: boolean };
    server.development = false;
    try {
      await call(INTERNAL_PATHS.planChanged, { userIds: [owner.id] }).expect(404);
    } finally {
      server.development = true;
    }
  });

  describe('authorize', () => {
    it('lets the owner and editors write', async () => {
      expect(await authorize(owner)).toMatchObject({
        ok: true,
        writable: true,
        user: { id: owner.id, name: 'Awa Kaboré', editor: true },
      });
      ctx.db.share(projectId, other.id, 'EDITOR');
      expect(await authorize(other)).toMatchObject({ ok: true, writable: true });
    });

    it.each(['SUPERVISOR', 'REVIEWER', 'VIEWER'] as const)('keeps a %s read-only', async (role) => {
      ctx.db.share(projectId, other.id, role);
      expect(await authorize(other)).toMatchObject({
        ok: true,
        writable: false,
        user: { editor: false },
      });
    });

    it('refuses no session, no role, a trashed project, a binary or unknown file', async () => {
      expect(await authorize(null)).toEqual({ ok: false });
      expect(await authorize(other)).toEqual({ ok: false });
      owner.disabledAt = new Date();
      expect(await authorize(owner)).toEqual({ ok: false });
      owner.disabledAt = null;
      expect(await authorize(owner, 'cunknownfile0000000000000')).toEqual({ ok: false });
      ctx.db.files.push({
        ...main(),
        id: 'cbinaryfile00000000000000',
        path: 'a.png',
        kind: 'BINARY',
      });
      expect(await authorize(owner, 'cbinaryfile00000000000000')).toEqual({ ok: false });
      ctx.db.projects[0]!.deletedAt = new Date();
      expect(await authorize(owner)).toEqual({ ok: false });
    });

    it('makes locked files, read-only projects and presence documents read-only', async () => {
      main().lockedBySubmissionId = 'submission';
      expect(await authorize(owner)).toMatchObject({ ok: true, writable: false });
      main().lockedBySubmissionId = null;
      ctx.db.projects[0]!.readOnlyReason = 'OVER_FREE_LIMIT';
      expect(await authorize(owner)).toMatchObject({ ok: true, writable: false });
      ctx.db.projects[0]!.readOnlyReason = null;
      expect(await authorize(owner, null)).toMatchObject({ ok: true, writable: false });
    });
  });

  describe('load and store', () => {
    it('loads the stored text, then the state once stored', async () => {
      const first = (await load().expect(200)).body;
      expect(first).toMatchObject({ state: null, key: main().storageKey });
      expect(first.text).toContain('\\documentclass');

      const saved = (await store('Thèse ∑', first.key)).body;
      expect(saved).toEqual({ code: null, text: null, key: main().storageKey });
      expect(saved.key).not.toBe(first.key);
      expect(stored()).toBe('Thèse ∑');
      expect(main().sizeBytes).toBe(strToU8('Thèse ∑').length);
      // One object per file: the old one is gone.
      expect([...ctx.storage.objects.keys()].filter((key) => key.includes(projectId))).toHaveLength(
        1,
      );
      expect((await load().expect(200)).body).toEqual({
        state: 'AQID',
        text: null,
        key: saved.key,
      });
    });

    it('hands back a text replaced outside the editor instead of overwriting it', async () => {
      const { key } = (await load()).body;
      await request(ctx.app.getHttpServer())
        .put(`/api/projects/${projectId}/files/upload?path=main.tex&replace=true`)
        .set('Origin', ORIGIN)
        .set(TEST_USER_HEADER, owner.id)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('uploaded'))
        .expect(200);
      const answer = (await store('typed', key)).body;
      expect(answer).toEqual({ code: null, text: 'uploaded', key: main().storageKey });
      expect(stored()).toBe('uploaded');
      // The state stored before the upload no longer matches: the next load gives the text.
      expect((await load()).body.text).toBe('uploaded');
    });

    it('stores nothing over the quota, over 10 MB, locked or read-only', async () => {
      const { key, text } = (await load()).body;
      ctx.db.plans.find((plan) => plan.code === 'FREE')!.storageBytes = 300n;
      expect((await store('a'.repeat(301), key, 'BBBB')).body).toEqual({
        code: 'storage_limit',
        text: null,
        key,
      });
      expect(stored()).toBe(text);
      // Neither the state: no text kept outside the quota.
      expect(ctx.db.documents.has(fileId)).toBe(false);

      ctx.db.plans.find((plan) => plan.code === 'FREE')!.storageBytes = 100n * 1024n * 1024n;
      expect((await store('a'.repeat(10 * 1024 * 1024 + 1), key)).body.code).toBe('file_too_large');
      main().lockedBySubmissionId = 'submission';
      expect((await store('x', key)).body.code).toBe('file_locked');
      main().lockedBySubmissionId = null;
      ctx.db.projects[0]!.readOnlyReason = 'OVER_FREE_LIMIT';
      expect((await store('x', key)).body.code).toBe('read_only');
      expect(stored()).toBe(text);
      expect(ctx.db.documents.has(fileId)).toBe(false);
    });

    it('refuses a state over the size limit', async () => {
      const { key } = (await load()).body;
      await call(INTERNAL_PATHS.store, {
        projectId,
        fileId,
        state: 'A'.repeat(28 * 1024 * 1024),
        text: 'x',
        baseKey: key,
      }).expect(400);
    });

    it('shows the stored text of a locked file, whatever its state holds', async () => {
      const { key } = (await load()).body;
      const saved = (await store('validated', key)).body;
      main().lockedBySubmissionId = 'submission';
      expect((await load()).body).toEqual({ state: 'AQID', text: 'validated', key: saved.key });
    });

    it('checks open connections without extending the session', async () => {
      const session = await sessionOf(owner);
      const redis = ctx.app.get(RedisService).client;
      await redis.expire(`sess:${sha256(session)}`, 100);
      const answer = await call(INTERNAL_PATHS.authorize, {
        session,
        projectId,
        fileId,
        recheck: true,
      }).expect(200);
      expect(answer.body.ok).toBe(true);
      expect(await redis.ttl(`sess:${sha256(session)}`)).toBeLessThanOrEqual(100);
    });

    it('charges the storage to the project owner whoever types', async () => {
      ctx.db.share(projectId, other.id, 'EDITOR');
      const { key } = (await load()).body;
      ctx.db.plans.find((plan) => plan.code === 'FREE')!.storageBytes = 1000n;
      ctx.db.personalPlans.set(other.id, 'STANDARD');
      expect((await store('a'.repeat(1001), key)).body.code).toBe('storage_limit');
    });

    it('answers not found for a deleted file or a trashed project', async () => {
      await load().expect(200);
      ctx.db.files.push({
        ...main(),
        id: 'cbinaryfile00000000000000',
        path: 'a.png',
        kind: 'BINARY',
      });
      await call(INTERNAL_PATHS.load, { projectId, fileId: 'cbinaryfile00000000000000' }).expect(
        404,
      );
      ctx.db.projects[0]!.deletedAt = new Date();
      expect((await store('x', null)).body.code).toBe('not_found');
    });
  });

  it('never leaks a binary file as text', async () => {
    await request(ctx.app.getHttpServer())
      .put(`/api/projects/${projectId}/files/upload?path=logo.png&replace=false`)
      .set('Origin', ORIGIN)
      .set(TEST_USER_HEADER, owner.id)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from(PNG))
      .expect(200);
    const logo = ctx.db.files.find((file) => file.path === 'logo.png')!;
    await call(INTERNAL_PATHS.load, { projectId, fileId: logo.id }).expect(404);
  });
});
