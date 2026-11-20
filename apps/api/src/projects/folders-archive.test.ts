import type { User } from '@integris/db';
import type { ArchiveGrant, ProjectDetail } from '@integris/shared';
import { strToU8, strFromU8, unzipSync } from 'fflate';
import http, { type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisService } from '../redis/redis.service.js';
import { ORIGIN } from '../test/auth-app.js';
import {
  createProjectsTestApp,
  type ProjectsTestApp,
  TEST_USER_HEADER,
} from '../test/projects-app.js';
import { ProjectEventsService } from './project-events.service.js';
import { archiveFileName } from './zip-export.js';
import { PNG } from './zip-import.test.js';

/** Collects a binary response body (the archive). */
const binary = (res: request.Response, done: (error: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};

describe('folders, moves and project download', () => {
  let ctx: ProjectsTestApp;
  let owner: User;
  let other: User;
  let projectId: string;

  const as = (user: User) => {
    const server = () => request(ctx.app.getHttpServer());
    const write = (req: request.Test) => req.set('Origin', ORIGIN).set(TEST_USER_HEADER, user.id);
    const base = `/api/projects/${projectId}`;
    return {
      get: (path = '') => server().get(`${base}${path}`).set(TEST_USER_HEADER, user.id),
      post: (path: string, body: object = {}) => write(server().post(`${base}${path}`)).send(body),
      patch: (path: string, body: object) => write(server().patch(`${base}${path}`)).send(body),
      delete: (path: string, body: object = {}) =>
        write(server().delete(`${base}${path}`)).send(body),
      upload: (path: string, bytes: Uint8Array) =>
        write(server().put(`${base}/files/upload?path=${encodeURIComponent(path)}`))
          .set('Content-Type', 'application/octet-stream')
          .send(Buffer.from(bytes)),
      archive: (token: string, zip = true) => {
        const req = server()
          .get(`${base}/archive?t=${encodeURIComponent(token)}`)
          .set(TEST_USER_HEADER, user.id);
        return zip ? req.buffer(true).parse(binary) : req;
      },
    };
  };

  const fileAt = (path: string) =>
    ctx.db.files.find((file) => file.projectId === projectId && file.path === path)!;
  const folders = () => ctx.db.folders.map((folder) => folder.path).sort();
  const actions = () => ctx.db.audits.map((row) => row.action);

  beforeAll(async () => {
    ctx = await createProjectsTestApp({
      PROJECT_MAX_FILES: '5',
      ZIP_MAX_FILES: '4',
      ZIP_EXPORTS_PER_HOUR: '3',
    });
  });

  beforeEach(async () => {
    ctx.db.reset();
    ctx.storage.objects.clear();
    await ctx.app.get(RedisService).client.flushdb();
    owner = ctx.db.addUser('Awa Kaboré');
    other = ctx.db.addUser('Issa Traoré');
    projectId = (
      await request(ctx.app.getHttpServer())
        .post('/api/projects')
        .set('Origin', ORIGIN)
        .set(TEST_USER_HEADER, owner.id)
        .send({ name: 'Mémoire : version 2' })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  describe('folders', () => {
    it('creates empty folders, lists them and counts them with the files', async () => {
      const detail = (await as(owner).post('/folders', { path: 'chapitres/annexes' }).expect(201))
        .body as ProjectDetail;
      expect(detail.folders).toEqual(['chapitres', 'chapitres/annexes']);
      await as(owner).post('/folders', { path: 'chapitres' }).expect(409, { code: 'path_taken' });
      await as(owner).post('/folders', { path: 'main.tex' }).expect(409, { code: 'path_taken' });
      await as(owner).post('/folders', { path: 'main.tex/x' }).expect(409);
      await as(owner).post('/folders', { path: '../x' }).expect(400, { code: 'invalid_path' });
      await as(owner).post('/files', { path: 'chapitres' }).expect(400);
      await as(owner).post('/files', { path: 'chapitres/annexes/a.tex' }).expect(201);
      // main.tex, a.tex and the kept folder: two more entries fit, then the limit.
      await as(owner).post('/folders', { path: 'figures' }).expect(201);
      await as(owner).post('/folders', { path: 'tables' }).expect(201);
      await as(owner).post('/folders', { path: 'x' }).expect(409, { code: 'too_many_files' });
      await as(owner).upload('b.tex', strToU8('B')).expect(409, { code: 'too_many_files' });
    });

    it('keeps a folder when its last file is deleted or moved away', async () => {
      await as(owner).upload('chapitres/intro.tex', strToU8('Intro')).expect(200);
      await as(owner).upload('figures/logo.png', PNG).expect(200);
      await as(owner)
        .delete(`/files/${fileAt('figures/logo.png').id}`)
        .expect(200);
      await as(owner)
        .patch(`/files/${fileAt('chapitres/intro.tex').id}`, { path: 'intro.tex' })
        .expect(200);
      expect(folders()).toEqual(['chapitres', 'figures']);
      expect(((await as(owner).get().expect(200)).body as ProjectDetail).folders).toEqual([
        'chapitres',
        'figures',
      ]);
    });

    it('deletes an empty folder and the empty folders inside', async () => {
      await as(owner).post('/folders', { path: 'a/b' }).expect(201);
      await as(owner).post('/folders', { path: 'a/c' }).expect(201);
      await as(owner).delete('/folders', { path: 'a' }).expect(200);
      expect(folders()).toEqual([]);
      await as(owner).delete('/folders', { path: 'a' }).expect(404);
    });

    it('needs the edit right', async () => {
      ctx.db.share(projectId, other.id, 'SUPERVISOR');
      await as(other).post('/folders', { path: 'x' }).expect(403, { code: 'forbidden' });
      ctx.db.projects[0]!.readOnlyReason = 'OVER_FREE_LIMIT';
      await as(owner).post('/folders', { path: 'x' }).expect(403, { code: 'read_only' });
    });
  });

  describe('moves', () => {
    it('moves a file and a folder with its empty folders, audited and told to the editors', async () => {
      await as(owner).upload('chap/intro.tex', strToU8('Intro')).expect(200);
      await as(owner).post('/folders', { path: 'chap/vide' }).expect(201);
      await as(owner).post('/folders', { path: 'parties' }).expect(201);
      ctx.db.share(projectId, other.id, 'EDITOR');
      const publish = vi.spyOn(ctx.app.get(ProjectEventsService), 'publish');

      const main = fileAt('main.tex');
      let detail = (
        await as(other).patch(`/files/${main.id}`, { path: 'parties/main.tex' }).expect(200)
      ).body as ProjectDetail;
      expect(detail.mainFilePath).toBe('parties/main.tex');
      detail = (await as(other).patch('/folders', { from: 'chap', to: 'parties/chap' }).expect(200))
        .body as ProjectDetail;
      expect(detail.files.map((file) => file.path)).toEqual([
        'parties/chap/intro.tex',
        'parties/main.tex',
      ]);
      expect(detail.folders).toEqual(['parties', 'parties/chap', 'parties/chap/vide']);
      expect(fileAt('parties/main.tex').id).toBe(main.id);
      expect(publish).toHaveBeenCalledWith({ type: 'files-changed', projectId });
      publish.mockRestore();
      expect(ctx.db.audits).toEqual([
        expect.objectContaining({
          actorId: other.id,
          action: 'FILE_MOVED',
          targetType: 'Project',
          targetId: projectId,
          metadata: { fileId: main.id, from: 'main.tex', to: 'parties/main.tex' },
        }),
        expect.objectContaining({
          action: 'FOLDER_MOVED',
          metadata: { from: 'chap', to: 'parties/chap', files: 1 },
        }),
      ]);
    });

    it('moves an empty folder, never into itself nor onto another one', async () => {
      await as(owner).post('/folders', { path: 'a' }).expect(201);
      await as(owner).post('/folders', { path: 'b' }).expect(201);
      await as(owner).patch('/folders', { from: 'a', to: 'b' }).expect(409, { code: 'path_taken' });
      await as(owner).patch('/folders', { from: 'a', to: 'a/x' }).expect(400);
      await as(owner).patch('/folders', { from: 'a', to: 'b/a' }).expect(200);
      expect(folders()).toEqual(['b', 'b/a']);
      await as(owner).patch('/folders', { from: 'b', to: 'main.tex' }).expect(409);
    });

    it('refuses to move a locked file or a folder holding one, and writes no audit entry', async () => {
      await as(owner).upload('chap/intro.tex', strToU8('Intro')).expect(200);
      fileAt('chap/intro.tex').lockedBySubmissionId = 'submission';
      await as(owner)
        .patch(`/files/${fileAt('chap/intro.tex').id}`, { path: 'intro.tex' })
        .expect(409, { code: 'file_locked' });
      await as(owner)
        .patch('/folders', { from: 'chap', to: 'x' })
        .expect(409, { code: 'file_locked' });
      expect(actions()).toEqual([]);
    });

    it.each(['SUPERVISOR', 'REVIEWER', 'VIEWER'] as const)(
      'refuses moves to a %s',
      async (role) => {
        ctx.db.share(projectId, other.id, role);
        await as(other)
          .patch(`/files/${fileAt('main.tex').id}`, { path: 'x.tex' })
          .expect(403, { code: 'forbidden' });
        await as(other).post('/folders', { path: 'x' }).expect(403);
      },
    );

    it('counts the folder left behind by a move in the limit', async () => {
      await as(owner).upload('f1/x.tex', strToU8('X')).expect(200);
      for (const path of ['a', 'b', 'c']) await as(owner).post('/folders', { path }).expect(201);
      // main.tex, f1/x.tex and 3 kept folders: keeping f1 would make 6 entries.
      await as(owner)
        .patch(`/files/${fileAt('f1/x.tex').id}`, { path: 'x.tex' })
        .expect(409, { code: 'too_many_files' });
      await as(owner)
        .patch(`/files/${fileAt('f1/x.tex').id}`, { path: 'f1/y.tex' })
        .expect(200);
    });

    it('moves nothing without its audit entry', async () => {
      ctx.db.failNextAudit = true;
      await as(owner)
        .patch(`/files/${fileAt('main.tex').id}`, { path: 'x.tex' })
        .expect(500);
      expect(fileAt('main.tex')).toBeDefined();
      expect(ctx.db.projects[0]!.mainFilePath).toBe('main.tex');
    });
  });

  describe('download', () => {
    const grant = async (user: User = owner) =>
      (await as(user).post('/archive').expect(200)).body as ArchiveGrant;

    it('streams the whole project, empty folders included, and can be imported again', async () => {
      await as(owner).upload('chapitres/intro.tex', strToU8('Introduction é')).expect(200);
      await as(owner).upload('figures/logo.png', PNG).expect(200);
      await as(owner).post('/folders', { path: 'annexes' }).expect(201);
      const { token, tooLargeForImport } = await grant();
      expect(tooLargeForImport).toBe(false);
      const response = await as(owner).archive(token).expect(200);
      expect(response.headers['content-type']).toBe('application/zip');
      expect(response.headers['content-disposition']).toBe(
        `attachment; filename="M_moire version 2.zip"; filename*=UTF-8''${encodeURIComponent('Mémoire version 2.zip')}`,
      );
      expect(response.headers['cache-control']).toBe('no-store');
      const entries = unzipSync(new Uint8Array(response.body as Buffer));
      expect(Object.keys(entries).sort()).toEqual([
        'annexes/',
        'chapitres/intro.tex',
        'figures/logo.png',
        'main.tex',
      ]);
      expect(strFromU8(entries['chapitres/intro.tex']!)).toBe('Introduction é');
      expect(Buffer.from(entries['figures/logo.png']!).equals(Buffer.from(PNG))).toBe(true);
      expect(ctx.db.audits).toEqual([
        expect.objectContaining({
          actorId: owner.id,
          action: 'PROJECT_DOWNLOADED',
          targetId: projectId,
          metadata: expect.objectContaining({ files: 3, folders: 1 }),
        }),
      ]);

      // The archive goes back through the ZIP import, empty folder included.
      const imported = await request(ctx.app.getHttpServer())
        .post('/api/projects/import?name=Copie')
        .set('Origin', ORIGIN)
        .set(TEST_USER_HEADER, owner.id)
        .set('Content-Type', 'application/zip')
        .send(response.body as Buffer)
        .expect(201);
      expect(imported.body.imported).toBe(3);
      expect(
        ctx.db.folders.filter((folder) => folder.projectId === imported.body.project.id),
      ).toEqual([expect.objectContaining({ path: 'annexes' })]);
    });

    it('is for the owner and editors only, read-only projects included', async () => {
      ctx.db.share(projectId, other.id, 'EDITOR');
      ctx.db.projects[0]!.readOnlyReason = 'OVER_FREE_LIMIT';
      await grant(other);
      for (const role of ['SUPERVISOR', 'REVIEWER', 'VIEWER'] as const) {
        ctx.db.members = [];
        ctx.db.share(projectId, other.id, role);
        await as(other).post('/archive').expect(403, { code: 'forbidden' });
      }
      ctx.db.members = [];
      await as(other).post('/archive').expect(404);
    });

    it('frees the project when a download is cancelled', async () => {
      // About 7 MB once compressed: more than the socket buffers, so the server waits.
      const big = strToU8(
        randomBytes(7 * 1024 * 1024)
          .toString('base64')
          .slice(0, 9_500_000),
      );
      await as(owner).upload('gros.txt', big).expect(200);
      const { token } = await grant();
      const server = ctx.app.getHttpServer() as Server;
      if (!server.listening) await new Promise<void>((resolve) => server.listen(0, resolve));
      const { port } = server.address() as AddressInfo;
      await new Promise<void>((resolve, reject) => {
        const req = http.get(
          `http://127.0.0.1:${port}/api/projects/${projectId}/archive?t=${encodeURIComponent(token)}`,
          { headers: { [TEST_USER_HEADER]: owner.id } },
          (res) => {
            expect(res.statusCode).toBe(200);
            // Nothing read: the server fills its buffers, then the user cancels.
            res.pause();
            setTimeout(() => {
              req.destroy();
              resolve();
            }, 300);
          },
        );
        req.on('error', (error) =>
          error.message.includes('socket hang up') ? undefined : reject(error),
        );
      });
      const redis = ctx.app.get(RedisService).client;
      await expect.poll(() => redis.exists(`lock:archive:${projectId}`), { timeout: 5000 }).toBe(0);
      await grant();
    });

    it('takes a token once, for the same user and project', async () => {
      ctx.db.share(projectId, other.id, 'EDITOR');
      const { token } = await grant();
      await as(other).archive(token, false).expect(410, { code: 'download_expired' });
      const second = await grant();
      await as(owner).archive(second.token).expect(200);
      await as(owner).archive(second.token).expect(410);
      await as(owner).archive('forged').expect(410);
    });

    it('allows one download at a time per project and a few per hour, never refused for its size', async () => {
      // Beyond the import limits (4 entries): a warning, never a refusal.
      for (const name of ['a', 'b', 'c']) await as(owner).post('/folders', { path: name });
      await as(owner).upload('e.tex', strToU8('E')).expect(200);
      const first = await grant();
      expect(first.tooLargeForImport).toBe(true);
      await ctx.app.get(RedisService).client.set(`lock:archive:${projectId}`, 'busy', 'PX', 5000);
      await as(owner).post('/archive').expect(409, { code: 'download_in_progress' });
      await as(owner).archive(first.token, false).expect(409, { code: 'download_in_progress' });
      await ctx.app.get(RedisService).client.del(`lock:archive:${projectId}`);
      await grant();
      await grant();
      const refused = await as(owner).post('/archive').expect(429);
      expect(refused.body).toMatchObject({ code: 'rate_limited', retryAfter: expect.any(Number) });
    });
  });

  it('names the archive after the project', () => {
    expect(archiveFileName('Mémoire : v2/3')).toBe('Mémoire v2 3.zip');
    expect(archiveFileName('***')).toBe('project.zip');
  });
});
