import type { User } from '@integris/db';
import { strToU8, zipSync } from 'fflate';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ORIGIN } from '../test/auth-app.js';
import {
  createProjectsTestApp,
  type ProjectsTestApp,
  TEST_USER_HEADER,
} from '../test/projects-app.js';
import { PNG } from './zip-import.test.js';

const MAIN = strToU8('\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n');

describe('projects API', () => {
  let ctx: ProjectsTestApp;
  let owner: User;
  let other: User;

  const as = (user: User) => {
    const server = () => request(ctx.app.getHttpServer());
    const write = (req: request.Test) => req.set('Origin', ORIGIN).set(TEST_USER_HEADER, user.id);
    return {
      get: (path: string) => server().get(`/api/${path}`).set(TEST_USER_HEADER, user.id),
      post: (path: string, body: object = {}) => write(server().post(`/api/${path}`)).send(body),
      patch: (path: string, body: object) => write(server().patch(`/api/${path}`)).send(body),
      delete: (path: string, body: object = {}) =>
        write(server().delete(`/api/${path}`)).send(body),
      upload: (projectId: string, path: string, bytes: Uint8Array, replace = false) =>
        write(
          server().put(
            `/api/projects/${projectId}/files/upload?path=${encodeURIComponent(path)}&replace=${replace}`,
          ),
        )
          .set('Content-Type', 'application/octet-stream')
          .send(Buffer.from(bytes)),
      import: (name: string, archive: Uint8Array) =>
        write(server().post(`/api/projects/import?name=${encodeURIComponent(name)}`))
          .set('Content-Type', 'application/zip')
          .send(Buffer.from(archive)),
    };
  };

  const create = async (user: User, name = 'Mémoire') =>
    (await as(user).post('projects', { name }).expect(201)).body.id as string;

  beforeAll(async () => {
    ctx = await createProjectsTestApp({
      ZIP_MAX_FILES: '50',
      ZIP_IMPORTS_PER_HOUR: '4',
      PROJECT_MAX_FILES: '3',
    });
  });

  beforeEach(() => {
    ctx.db.reset();
    ctx.storage.objects.clear();
    owner = ctx.db.addUser('Awa Kaboré');
    other = ctx.db.addUser('Issa Traoré');
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  describe('creation and listing', () => {
    it('creates an empty project with a main.tex in the language of the user', async () => {
      const id = await create(owner, 'Mon {rapport}');
      const detail = (await as(owner).get(`projects/${id}`).expect(200)).body;
      expect(detail).toMatchObject({
        name: 'Mon {rapport}',
        role: 'OWNER',
        mainFilePath: 'main.tex',
      });
      expect(detail.rights).toEqual({ read: true, edit: true, manage: true });
      expect(detail.files.map((file: { path: string }) => file.path)).toEqual(['main.tex']);
      const key = ctx.db.files[0]!.storageKey!;
      const text = new TextDecoder().decode(ctx.storage.objects.get(`projects/${key}`));
      expect(text).toContain('\\usepackage[french]{babel}');
      expect(text).toContain('\\title{Mon  rapport}');
      expect(key.startsWith(`${id}/`)).toBe(true);
    });

    it('lists owned and shared projects with the usage of the plan', async () => {
      await create(owner);
      const shared = await create(other, 'Article');
      ctx.db.share(shared, owner.id, 'VIEWER');
      await create(other, 'Privé');
      const { body } = await as(owner).get('projects').expect(200);
      expect(body.projects.map((p: { name: string; role: string }) => [p.name, p.role])).toEqual(
        expect.arrayContaining([
          ['Mémoire', 'OWNER'],
          ['Article', 'VIEWER'],
        ]),
      );
      expect(body.projects).toHaveLength(2);
      expect(body.usage).toMatchObject({ planCode: 'FREE', projects: 1, maxProjects: 3 });
      expect(body.usage.maxStorageBytes).toBe(100 * 1024 * 1024);
    });

    it('blocks the 4th project on the FREE plan, read from the Plan table', async () => {
      for (let index = 0; index < 3; index++) await create(owner);
      await as(owner).post('projects', { name: 'Quatre' }).expect(402, { code: 'project_limit' });
      // The limit is data: raising it in the table lifts the block.
      ctx.db.plans.find((plan) => plan.code === 'FREE')!.maxProjects = 4;
      await as(owner).post('projects', { name: 'Quatre' }).expect(201);
    });

    it('applies the best plan held (personal STANDARD: unlimited projects)', async () => {
      ctx.db.personalPlans.set(owner.id, 'STANDARD');
      for (let index = 0; index < 4; index++) await create(owner);
      const { body } = await as(owner).get('projects').expect(200);
      expect(body.usage).toMatchObject({ planCode: 'STANDARD', projects: 4, maxProjects: null });
    });

    it('validates the name', async () => {
      await as(owner).post('projects', { name: '  ' }).expect(400, { code: 'invalid_request' });
    });
  });

  describe('access rights', () => {
    it('hides a project from a user without a role', async () => {
      const id = await create(owner);
      await as(other).get(`projects/${id}`).expect(404, { code: 'not_found' });
      await as(other).upload(id, 'x.tex', MAIN).expect(404);
      await as(other).post(`projects/${id}/trash`).expect(404);
    });

    it('lets an editor edit files but not manage the project', async () => {
      const id = await create(owner);
      ctx.db.share(id, other.id, 'EDITOR');
      await as(other).upload(id, 'intro.tex', strToU8('Intro')).expect(200);
      await as(other).patch(`projects/${id}`, { name: 'X' }).expect(403, { code: 'forbidden' });
      await as(other).post(`projects/${id}/trash`).expect(403);
    });

    it.each(['SUPERVISOR', 'REVIEWER', 'VIEWER'] as const)('keeps a %s read-only', async (role) => {
      const id = await create(owner);
      ctx.db.share(id, other.id, role);
      const detail = (await as(other).get(`projects/${id}`).expect(200)).body;
      expect(detail.rights).toEqual({ read: true, edit: false, manage: false });
      await as(other).upload(id, 'x.tex', MAIN).expect(403, { code: 'forbidden' });
      await as(other).post(`projects/${id}/files`, { path: 'y.tex' }).expect(403);
      await as(other).delete(`projects/${id}/files/${detail.files[0].id}`).expect(403);
    });

    it('refuses edits on a read-only project', async () => {
      const id = await create(owner);
      ctx.db.projects[0]!.readOnlyReason = 'OVER_FREE_LIMIT';
      await as(owner).upload(id, 'x.tex', MAIN).expect(403, { code: 'read_only' });
    });

    it('refuses a write without an allowed origin or with a form body', async () => {
      const id = await create(owner);
      await request(ctx.app.getHttpServer())
        .put(`/api/projects/${id}/files/upload?path=x.tex`)
        .set(TEST_USER_HEADER, owner.id)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from(MAIN))
        .expect(403, { code: 'forbidden_origin' });
      await request(ctx.app.getHttpServer())
        .put(`/api/projects/${id}/files/upload?path=x.tex`)
        .set('Origin', ORIGIN)
        .set(TEST_USER_HEADER, owner.id)
        .set('Content-Type', 'multipart/form-data; boundary=x')
        .send('--x--')
        .expect(403, { code: 'forbidden_origin' });
    });
  });

  describe('files', () => {
    it('uploads a file after checking its extension and its real type', async () => {
      const id = await create(owner);
      await as(owner).upload(id, 'figures/logo.png', PNG).expect(200);
      await as(owner)
        .upload(id, 'evil.png', strToU8('<svg/>'))
        .expect(422, { code: 'type_mismatch' });
      await as(owner).upload(id, 'image.svg', strToU8('<svg/>')).expect(422, {
        code: 'extension_not_allowed',
      });
      await as(owner).upload(id, 'run.sh', strToU8('rm -rf /')).expect(422);
      await as(owner)
        .upload(id, 'cp1252.tex', new Uint8Array([0xe9]))
        .expect(422, {
          code: 'invalid_encoding',
        });
      await as(owner).upload(id, '../x.tex', MAIN).expect(400, { code: 'invalid_path' });
      const files = (await as(owner).get(`projects/${id}`)).body.files;
      expect(files.map((file: { path: string; kind: string }) => [file.path, file.kind])).toEqual([
        ['figures/logo.png', 'BINARY'],
        ['main.tex', 'TEXT'],
      ]);
    });

    it('refuses a file over 10 MB before reading it', async () => {
      const id = await create(owner);
      const big = new Uint8Array(10 * 1024 * 1024 + 1).fill(0x61);
      await as(owner).upload(id, 'big.txt', big).expect(413, { code: 'file_too_large' });
    });

    it('replaces a file only when asked', async () => {
      const id = await create(owner);
      await as(owner).upload(id, 'main.tex', MAIN).expect(409, { code: 'path_taken' });
      await as(owner).upload(id, 'main.tex', MAIN, true).expect(200);
      expect(ctx.storage.objects.size).toBe(1);
    });

    it('charges the storage to the project owner and blocks over quota', async () => {
      ctx.db.plans.find((plan) => plan.code === 'FREE')!.storageBytes = 2000n;
      const id = await create(owner);
      ctx.db.share(id, other.id, 'EDITOR');
      const text = new Uint8Array(1900).fill(0x61);
      await as(other).upload(id, 'big.txt', text).expect(402, { code: 'storage_limit' });
    });

    it('renames files and folders and follows the main file', async () => {
      const id = await create(owner);
      await as(owner).upload(id, 'chap/intro.tex', strToU8('Intro')).expect(200);
      let detail = (await as(owner).get(`projects/${id}`)).body;
      const main = detail.files.find((file: { path: string }) => file.path === 'main.tex');
      detail = (
        await as(owner).patch(`projects/${id}/files/${main.id}`, { path: 'these.tex' }).expect(200)
      ).body;
      expect(detail.mainFilePath).toBe('these.tex');
      await as(owner)
        .patch(`projects/${id}/files/${main.id}`, { path: 'chap/intro.tex' })
        .expect(409, { code: 'path_taken' });
      await as(owner).upload(id, 'logo.png', PNG).expect(200);
      const logo = ctx.db.files.find((file) => file.path === 'logo.png')!;
      await as(owner)
        .patch(`projects/${id}/files/${logo.id}`, { path: 'logo.tex' })
        .expect(422, { code: 'type_mismatch' });
      detail = (
        await as(owner)
          .patch(`projects/${id}/folders`, { from: 'chap', to: 'chapitres' })
          .expect(200)
      ).body;
      expect(detail.files.map((file: { path: string }) => file.path)).toContain(
        'chapitres/intro.tex',
      );
      await as(owner)
        .patch(`projects/${id}/folders`, { from: 'chapitres', to: 'chapitres/a' })
        .expect(400);
      await as(owner).delete(`projects/${id}/folders`, { path: 'chapitres' }).expect(200);
      expect(ctx.db.files.map((file) => file.path).sort()).toEqual(['logo.png', 'these.tex']);
    });

    it('refuses to change a file locked by a validated submission', async () => {
      const id = await create(owner);
      const file = ctx.db.files[0]!;
      file.lockedBySubmissionId = 'submission';
      await as(owner)
        .delete(`projects/${id}/files/${file.id}`)
        .expect(409, { code: 'file_locked' });
      await as(owner).upload(id, 'main.tex', MAIN, true).expect(409, { code: 'file_locked' });
    });

    it('limits the number of files of a project', async () => {
      const id = await create(owner);
      await as(owner).post(`projects/${id}/files`, { path: 'a.tex' }).expect(201);
      await as(owner).upload(id, 'b.tex', MAIN).expect(200);
      await as(owner).upload(id, 'c.tex', MAIN).expect(409, { code: 'too_many_files' });
      await as(owner).post(`projects/${id}/files`, { path: 'd.tex' }).expect(409);
      // Replacing an existing file is still possible.
      await as(owner).upload(id, 'b.tex', MAIN, true).expect(200);
    });

    it('only accepts a .tex file of the project as main file', async () => {
      const id = await create(owner);
      await as(owner).upload(id, 'refs.bib', strToU8('@x')).expect(200);
      await as(owner).patch(`projects/${id}`, { mainFilePath: 'refs.bib' }).expect(400);
      await as(owner).patch(`projects/${id}`, { mainFilePath: 'none.tex' }).expect(400);
    });
  });

  describe('ZIP import', () => {
    it('imports a ZIP and reports the files left out', async () => {
      const archive = zipSync({
        'export/these.tex': MAIN,
        'export/img/a.png': PNG,
        'export/script.py': strToU8('print(1)'),
      });
      const { body } = await as(owner).import('Thèse', archive).expect(201);
      expect(body.imported).toBe(2);
      expect(body.skipped).toEqual([{ path: 'script.py', reason: 'extension_not_allowed' }]);
      const detail = (await as(owner).get(`projects/${body.project.id}`)).body;
      expect(detail.mainFilePath).toBe('these.tex');
    });

    it('refuses an unsafe archive without creating anything', async () => {
      const archive = zipSync({ 'main.tex': MAIN, '../../etc/x.tex': MAIN });
      await as(owner).import('X', archive).expect(422, { code: 'archive_unsafe' });
      expect(ctx.db.projects).toHaveLength(0);
      expect(ctx.storage.objects.size).toBe(0);
    });

    it('rate limits imports per user before reading the archive', async () => {
      ctx.db.personalPlans.set(owner.id, 'STANDARD');
      for (let index = 0; index < 4; index++) {
        await as(owner)
          .import(`P${index}`, zipSync({ 'main.tex': MAIN }))
          .expect(201);
      }
      await as(owner)
        .import('P5', zipSync({ 'main.tex': MAIN }))
        .expect(429, {
          code: 'rate_limited',
          retryAfter: 3600,
        });
    });

    it('refuses a chunked archive over the limit while reading it', async () => {
      const app = await createProjectsTestApp({ ZIP_MAX_ARCHIVE_BYTES: '1000' });
      const user = app.db.addUser('Awa');
      const req = request(app.app.getHttpServer())
        .post('/api/projects/import?name=X')
        .set('Origin', ORIGIN)
        .set(TEST_USER_HEADER, user.id)
        .set('Content-Type', 'application/zip')
        .set('Transfer-Encoding', 'chunked');
      req.write(Buffer.alloc(800));
      req.write(Buffer.alloc(800));
      await req.expect(413, { code: 'archive_too_large' });
      await app.app.close();
    });

    it('applies the project limit to imports', async () => {
      for (let index = 0; index < 3; index++) await create(owner);
      await as(owner)
        .import('X', zipSync({ 'main.tex': MAIN }))
        .expect(402, {
          code: 'project_limit',
        });
    });
  });

  describe('trash', () => {
    it('moves to the trash, restores and erases for good', async () => {
      const id = await create(owner);
      await as(owner).post(`projects/${id}/trash`).expect(204);
      expect((await as(owner).get('projects')).body.projects).toHaveLength(0);
      const trash = (await as(owner).get('projects?view=trash')).body.projects;
      expect(trash[0].purgeAt).toBeTruthy();
      await as(owner).get(`projects/${id}`).expect(404);
      await as(owner).post(`projects/${id}/restore`).expect(204);
      await as(owner).delete(`projects/${id}`).expect(409, { code: 'not_in_trash' });
      await as(owner).post(`projects/${id}/trash`).expect(204);
      await as(owner).delete(`projects/${id}`).expect(204);
      expect(ctx.db.projects).toHaveLength(0);
      expect(ctx.storage.objects.size).toBe(0);
    });

    it('keeps the trace of validations: never erases a validated submission without it', async () => {
      const id = await create(owner);
      ctx.db.validated.push({ projectId: id, id: 'submission-1' });
      await as(owner).post(`projects/${id}/trash`).expect(204);
      await as(owner).delete(`projects/${id}`).expect(409, { code: 'erase_blocked' });
      expect(ctx.db.projects).toHaveLength(1);
      // With its trace (metadata kept apart), the project and the submission are erased.
      ctx.db.traced.add('submission-1');
      await as(owner).delete(`projects/${id}`).expect(204);
      expect(ctx.db.projects).toHaveLength(0);
      expect(ctx.db.traced.has('submission-1')).toBe(true);
    });

    it('hides a trashed project from its members', async () => {
      const id = await create(owner);
      ctx.db.share(id, other.id, 'EDITOR');
      await as(owner).post(`projects/${id}/trash`).expect(204);
      await as(other).get(`projects/${id}`).expect(404);
      await as(other).post(`projects/${id}/restore`).expect(404);
    });

    it('does not count trashed projects in the project limit, but checks it on restore', async () => {
      const first = await create(owner);
      await as(owner).post(`projects/${first}/trash`).expect(204);
      for (let index = 0; index < 3; index++) await create(owner);
      await as(owner).post(`projects/${first}/restore`).expect(402, { code: 'project_limit' });
    });

    it('keeps trashed files in the storage usage', async () => {
      const id = await create(owner);
      const size = ctx.db.files[0]!.sizeBytes;
      await as(owner).post(`projects/${id}/trash`).expect(204);
      expect((await as(owner).get('projects')).body.usage.storageBytes).toBe(size);
    });

    it('duplicates a project for its owner only', async () => {
      const id = await create(owner);
      ctx.db.share(id, other.id, 'EDITOR');
      await as(other).post(`projects/${id}/duplicate`, { name: 'Copie' }).expect(403);
      const copy = (await as(owner).post(`projects/${id}/duplicate`, { name: 'Copie' }).expect(201))
        .body;
      expect(copy.name).toBe('Copie');
      expect(ctx.storage.objects.size).toBe(2);
    });
  });
});
