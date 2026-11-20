import type { User } from '@integris/db';
import { AUTO_VERSION_DELAY_MS } from '@integris/shared';
import { strToU8 } from 'fflate';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PNG } from '../projects/zip-import.test.js';
import { RedisService } from '../redis/redis.service.js';
import { ORIGIN } from '../test/auth-app.js';
import {
  createProjectsTestApp,
  type ProjectsTestApp,
  TEST_USER_HEADER,
} from '../test/projects-app.js';
import { HistorySchedulerService } from './history-scheduler.service.js';
import { HistoryModule } from './history.module.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('version history', () => {
  let ctx: ProjectsTestApp;
  let owner: User;
  let other: User;
  let projectId: string;

  const as = (user: User) => {
    const server = () => request(ctx.app.getHttpServer());
    const write = (req: request.Test) => req.set('Origin', ORIGIN).set(TEST_USER_HEADER, user.id);
    return {
      get: (path: string) => server().get(`/api/${path}`).set(TEST_USER_HEADER, user.id),
      post: (path: string, body: object = {}) => write(server().post(`/api/${path}`)).send(body),
      delete: (path: string) => write(server().delete(`/api/${path}`)).send({}),
      upload: (path: string, bytes: Uint8Array, replace = false) =>
        write(
          server().put(
            `/api/projects/${projectId}/files/upload?path=${encodeURIComponent(path)}&replace=${replace}`,
          ),
        )
          .set('Content-Type', 'application/octet-stream')
          .send(Buffer.from(bytes)),
    };
  };

  const fileAt = (path: string) =>
    ctx.db.files.find((file) => file.projectId === projectId && file.path === path);
  const textAt = (path: string) =>
    new TextDecoder().decode(ctx.storage.objects.get(`projects/${fileAt(path)!.storageKey}`));
  const name = (user: User, label: string) =>
    as(user).post(`projects/${projectId}/versions`, { label });
  const list = async (user: User = owner) =>
    (await as(user).get(`projects/${projectId}/versions`).expect(200)).body;
  const historyObjects = () =>
    [...ctx.storage.objects.keys()].filter(
      (key) => key.includes(`${projectId}/history/`) && !key.includes('manifest-'),
    );
  const scheduler = () => ctx.app.get(HistorySchedulerService);
  const redis = () => ctx.app.get(RedisService).client;

  beforeAll(async () => {
    ctx = await createProjectsTestApp({ HISTORY_ACTIONS_PER_HOUR: '3' }, [HistoryModule]);
  });

  beforeEach(async () => {
    ctx.db.reset();
    ctx.storage.objects.clear();
    await redis().flushdb();
    owner = ctx.db.addUser('Awa Kaboré');
    other = ctx.db.addUser('Issa Traoré');
    projectId = (await as(owner).post('projects', { name: 'Mémoire' }).expect(201)).body.id;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  describe('named versions and rights', () => {
    it('names a version for the owner and editors, lists it for every role', async () => {
      const { body } = await name(owner, 'Chapitre 2 terminé').expect(201);
      expect(body).toMatchObject({
        kind: 'NAMED',
        label: 'Chapitre 2 terminé',
        authorName: 'Awa Kaboré',
        fileCount: 1,
        restoreOf: null,
      });
      ctx.db.share(projectId, other.id, 'EDITOR');
      await name(other, 'Relu').expect(201);
      expect((await list(other)).versions.map((v: { label: string }) => v.label)).toEqual([
        'Relu',
        'Chapitre 2 terminé',
      ]);
    });

    it.each(['SUPERVISOR', 'REVIEWER', 'VIEWER'] as const)(
      'lets a %s read the history but neither name nor restore',
      async (role) => {
        ctx.db.share(projectId, other.id, role);
        const version = (await name(owner, 'v1').expect(201)).body;
        const seen = await list(other);
        expect(seen.versions).toHaveLength(1);
        expect(seen.canRestore).toBe(false);
        await as(other).get(`projects/${projectId}/versions/${version.id}`).expect(200);
        await name(other, 'x').expect(403, { code: 'forbidden' });
        await as(other)
          .post(`projects/${projectId}/versions/${version.id}/restore`)
          .expect(403, { code: 'forbidden' });
      },
    );

    it('hides the history from users without a role', async () => {
      await as(other).get(`projects/${projectId}/versions`).expect(404);
      await name(other, 'x').expect(404);
    });

    it('limits named versions and restorations per user and per hour', async () => {
      for (let index = 0; index < 3; index++) await name(owner, `v${index}`).expect(201);
      await name(owner, 'v3').expect(429, { code: 'rate_limited', retryAfter: 3600 });
    });

    it('refuses an empty or too long label', async () => {
      await name(owner, '  ').expect(400);
      await name(owner, 'x'.repeat(101)).expect(400);
    });
  });

  describe('automatic versions', () => {
    it('takes one 10 minutes after the first change, and none without change', async () => {
      const start = Date.now();
      await as(owner).upload('notes.txt', strToU8('a')).expect(200);
      await as(owner).upload('notes.txt', strToU8('b'), true).expect(200);
      // Not due yet: 10 minutes after the first change, not the last.
      expect(await scheduler().run(start + AUTO_VERSION_DELAY_MS - 1000)).toBe(0);
      expect(await scheduler().run(Date.now() + AUTO_VERSION_DELAY_MS)).toBe(1);
      const [auto] = (await list()).versions;
      expect(auto).toMatchObject({ kind: 'AUTO', label: null, authorName: null, fileCount: 2 });
      // Nothing is due any more.
      expect(await scheduler().run(Date.now() + 2 * AUTO_VERSION_DELAY_MS)).toBe(0);
      // A change that changes nothing in the end (renamed back) gives no new version.
      const notes = fileAt('notes.txt')!;
      await request(ctx.app.getHttpServer())
        .patch(`/api/projects/${projectId}/files/${notes.id}`)
        .set('Origin', ORIGIN)
        .set(TEST_USER_HEADER, owner.id)
        .send({ path: 'notes.txt' })
        .expect(200);
      expect(await scheduler().run(Date.now() + 2 * AUTO_VERSION_DELAY_MS)).toBe(0);
    });

    it('copies an unchanged file once for all versions', async () => {
      await as(owner).upload('logo.png', PNG).expect(200);
      await name(owner, 'v1').expect(201);
      await as(owner).upload('notes.txt', strToU8('a')).expect(200);
      await name(owner, 'v2').expect(201);
      // main.tex, logo.png, then notes.txt: three copies for two versions.
      expect(historyObjects()).toHaveLength(3);
    });
  });

  describe('history limit of the plan', () => {
    it('hides versions older than the limit of the owner, and shows them again', async () => {
      ctx.db.plans.find((plan) => plan.code === 'FREE')!.historyDays = 1;
      const old = (await name(owner, 'old').expect(201)).body;
      await name(owner, 'recent').expect(201);
      ctx.db.versions.find((v) => v.id === old.id)!.createdAt = new Date(Date.now() - 2 * DAY_MS);

      const limited = await list();
      expect(limited.versions.map((v: { label: string }) => v.label)).toEqual(['recent']);
      expect(limited).toMatchObject({ historyDays: 1, hiddenCount: 1 });
      await as(owner).get(`projects/${projectId}/versions/${old.id}`).expect(404);
      await as(owner).post(`projects/${projectId}/versions/${old.id}/restore`).expect(404);

      // The limit is the one of the project owner, not of the reader.
      ctx.db.share(projectId, other.id, 'EDITOR');
      ctx.db.personalPlans.set(other.id, 'STANDARD');
      expect((await list(other)).hiddenCount).toBe(1);

      // Nothing was deleted: a higher plan shows it again.
      ctx.db.personalPlans.set(owner.id, 'STANDARD');
      expect((await list()).versions).toHaveLength(2);
      await as(owner).get(`projects/${projectId}/versions/${old.id}`).expect(200);
    });
  });

  describe('detail and preview', () => {
    it('compares a version with the project and previews its text files', async () => {
      await as(owner).upload('logo.png', PNG).expect(200);
      await as(owner).upload('a.tex', strToU8('A1')).expect(200);
      const version = (await name(owner, 'v1').expect(201)).body;
      await as(owner).upload('a.tex', strToU8('A2'), true).expect(200);
      await as(owner)
        .delete(`projects/${projectId}/files/${fileAt('logo.png')!.id}`)
        .expect(200);
      await as(owner).upload('b.tex', strToU8('B')).expect(200);

      const { body } = await as(owner)
        .get(`projects/${projectId}/versions/${version.id}`)
        .expect(200);
      expect(body.files).toEqual([
        { path: 'a.tex', kind: 'TEXT', sizeBytes: 2, change: 'modified' },
        { path: 'logo.png', kind: 'BINARY', sizeBytes: PNG.length, change: 'removed' },
        { path: 'main.tex', kind: 'TEXT', sizeBytes: expect.any(Number), change: 'same' },
      ]);
      expect(body.added).toEqual(['b.tex']);

      const preview = await as(owner)
        .get(`projects/${projectId}/versions/${version.id}/file?path=a.tex`)
        .expect(200);
      expect(preview.text).toBe('A1');
      expect(preview.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
      await as(owner)
        .get(`projects/${projectId}/versions/${version.id}/file?path=logo.png`)
        .expect(415);
      await as(owner)
        .get(`projects/${projectId}/versions/${version.id}/file?path=none.tex`)
        .expect(404);
    });
  });

  describe('restoration', () => {
    const restore = (versionId: string, body: object = {}) =>
      as(owner).post(`projects/${projectId}/versions/${versionId}/restore`, body);

    it('restores the whole project and saves the current state first', async () => {
      await as(owner).upload('logo.png', PNG).expect(200);
      await as(owner).upload('a.tex', strToU8('A1')).expect(200);
      const version = (await name(owner, 'v1').expect(201)).body;
      await as(owner).upload('a.tex', strToU8('A2'), true).expect(200);
      await as(owner)
        .delete(`projects/${projectId}/files/${fileAt('logo.png')!.id}`)
        .expect(200);
      await as(owner).upload('b.tex', strToU8('B')).expect(200);
      const aId = fileAt('a.tex')!.id;

      const { body } = await restore(version.id).expect(201);
      expect(body).toEqual({ restored: 2, removed: 1, kept: [] });
      expect(textAt('a.tex')).toBe('A1');
      // Same file (its collaborative document goes on), content as in the version.
      expect(fileAt('a.tex')!.id).toBe(aId);
      expect(fileAt('logo.png')).toBeDefined();
      expect(fileAt('b.tex')).toBeUndefined();

      const [before] = (await list()).versions;
      expect(before).toMatchObject({
        kind: 'AUTO',
        authorName: 'Awa Kaboré',
        restoreOf: { createdAt: version.createdAt, path: null },
        fileCount: 3,
      });
      // The state before the restoration can itself be restored.
      const detail = (await as(owner).get(`projects/${projectId}/versions/${before.id}`)).body;
      expect(detail.added).toEqual(['logo.png']);
      expect(ctx.db.audits).toEqual([
        expect.objectContaining({
          actorId: owner.id,
          action: 'VERSION_RESTORED',
          targetType: 'Project',
          targetId: projectId,
        }),
      ]);
    });

    it('restores one file only', async () => {
      await as(owner).upload('a.tex', strToU8('A1')).expect(200);
      const version = (await name(owner, 'v1').expect(201)).body;
      await as(owner).upload('a.tex', strToU8('A2'), true).expect(200);
      await as(owner).upload('b.tex', strToU8('B')).expect(200);
      const { body } = await restore(version.id, { path: 'a.tex' }).expect(201);
      expect(body).toEqual({ restored: 1, removed: 0, kept: [] });
      expect(textAt('a.tex')).toBe('A1');
      expect(fileAt('b.tex')).toBeDefined();
      expect((await list()).versions[0].restoreOf).toEqual({
        createdAt: version.createdAt,
        path: 'a.tex',
      });
      await restore(version.id, { path: 'none.tex' }).expect(404);
    });

    it('follows moved files: the same file goes back, with its comments, and paths can swap', async () => {
      await as(owner).upload('a.tex', strToU8('A1')).expect(200);
      await as(owner).upload('b.tex', strToU8('B1')).expect(200);
      await as(owner).post(`projects/${projectId}/folders`, { path: 'annexes/vide' }).expect(201);
      const version = (await name(owner, 'v1').expect(201)).body;
      const a = fileAt('a.tex')!;
      const b = fileAt('b.tex')!;
      ctx.db.comments.push({
        id: 'comment-1',
        projectId,
        fileId: a.id,
        authorId: owner.id,
        anchor: {},
        quotedText: 'A1',
        body: 'Note',
        suggestedText: null,
        suggestionStatus: null,
        suggestionDecidedById: null,
        suggestionDecidedAt: null,
        status: 'OPEN',
        submissionId: null,
        createdAt: new Date(),
        resolvedAt: null,
        resolvedById: null,
      });
      // a.tex and b.tex swap their paths, a.tex changes, the empty folder goes.
      const move = (id: string, path: string) =>
        request(ctx.app.getHttpServer())
          .patch(`/api/projects/${projectId}/files/${id}`)
          .set('Origin', ORIGIN)
          .set(TEST_USER_HEADER, owner.id)
          .send({ path })
          .expect(200);
      await move(a.id, 'tmp.tex');
      await move(b.id, 'a.tex');
      await move(a.id, 'b.tex');
      await as(owner).upload('b.tex', strToU8('A2'), true).expect(200);
      await request(ctx.app.getHttpServer())
        .delete(`/api/projects/${projectId}/folders`)
        .set('Origin', ORIGIN)
        .set(TEST_USER_HEADER, owner.id)
        .send({ path: 'annexes' })
        .expect(200);

      const detail = (await as(owner).get(`projects/${projectId}/versions/${version.id}`)).body;
      expect(
        detail.files.map((file: { path: string; change: string }) => [file.path, file.change]),
      ).toEqual([
        ['a.tex', 'moved'],
        ['b.tex', 'moved'],
        ['main.tex', 'same'],
      ]);
      expect(detail.added).toEqual([]);

      const { body } = await restore(version.id).expect(201);
      expect(body).toEqual({ restored: 2, removed: 0, kept: [] });
      expect(fileAt('a.tex')!.id).toBe(a.id);
      expect(fileAt('b.tex')!.id).toBe(b.id);
      expect(textAt('a.tex')).toBe('A1');
      expect(textAt('b.tex')).toBe('B1');
      expect(ctx.db.comments[0]!.fileId).toBe(a.id);
      expect(ctx.db.folders.map((folder) => folder.path)).toEqual(['annexes/vide']);
    });

    it('never puts a file back where an empty folder now stands', async () => {
      await as(owner).upload('a.tex', strToU8('A1')).expect(200);
      const version = (await name(owner, 'v1').expect(201)).body;
      await as(owner)
        .delete(`projects/${projectId}/files/${fileAt('a.tex')!.id}`)
        .expect(200);
      await as(owner).post(`projects/${projectId}/folders`, { path: 'a.tex' }).expect(201);
      const { body } = await restore(version.id, { path: 'a.tex' }).expect(201);
      expect(body).toEqual({ restored: 0, removed: 0, kept: ['a.tex'] });
      expect(fileAt('a.tex')).toBeUndefined();
    });

    it('restores the content of one moved file where it is now', async () => {
      await as(owner).upload('a.tex', strToU8('A1')).expect(200);
      const version = (await name(owner, 'v1').expect(201)).body;
      const a = fileAt('a.tex')!;
      await request(ctx.app.getHttpServer())
        .patch(`/api/projects/${projectId}/files/${a.id}`)
        .set('Origin', ORIGIN)
        .set(TEST_USER_HEADER, owner.id)
        .send({ path: 'parties/a.tex' })
        .expect(200);
      await as(owner).upload('parties/a.tex', strToU8('A2'), true).expect(200);
      const { body } = await restore(version.id, { path: 'a.tex' }).expect(201);
      expect(body).toEqual({ restored: 1, removed: 0, kept: [] });
      expect(fileAt('a.tex')).toBeUndefined();
      expect(fileAt('parties/a.tex')!.id).toBe(a.id);
      expect(textAt('parties/a.tex')).toBe('A1');
    });

    it('leaves files locked by a validated submission as they are', async () => {
      await as(owner).upload('a.tex', strToU8('A1')).expect(200);
      const version = (await name(owner, 'v1').expect(201)).body;
      await as(owner).upload('a.tex', strToU8('A2'), true).expect(200);
      await as(owner).upload('b.tex', strToU8('B')).expect(200);
      fileAt('a.tex')!.lockedBySubmissionId = 'submission';
      fileAt('b.tex')!.lockedBySubmissionId = 'submission';
      const { body } = await restore(version.id).expect(201);
      expect(body).toEqual({ restored: 0, removed: 0, kept: ['a.tex', 'b.tex'] });
      expect(textAt('a.tex')).toBe('A2');
    });

    it('checks the storage quota of the owner and the read-only state', async () => {
      await as(owner).upload('logo.png', PNG).expect(200);
      const version = (await name(owner, 'v1').expect(201)).body;
      await as(owner)
        .delete(`projects/${projectId}/files/${fileAt('logo.png')!.id}`)
        .expect(200);
      const used = ctx.db.files.reduce((total, file) => total + file.sizeBytes, 0);
      ctx.db.plans.find((plan) => plan.code === 'FREE')!.storageBytes = BigInt(used + 10);
      await restore(version.id).expect(402, { code: 'storage_limit' });
      ctx.db.plans.find((plan) => plan.code === 'FREE')!.storageBytes = 100n * 1024n * 1024n;
      ctx.db.projects[0]!.readOnlyReason = 'OVER_FREE_LIMIT';
      await restore(version.id).expect(403, { code: 'read_only' });
      expect((await list()).canRestore).toBe(false);
    });
  });
});
