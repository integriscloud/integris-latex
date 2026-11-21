import type { User } from '@integris/db';
import type {
  CompileResult,
  SubmissionComparison,
  SubmissionDetail,
  SubmissionList,
  ToReviewList,
} from '@integris/shared';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompileService } from '../compile/compile.service.js';
import { CollabDocsService } from '../collab/collab-docs.service.js';
import { CollabModule } from '../collab/collab.module.js';
import { HistoryModule } from '../history/history.module.js';
import { ProjectEventsService } from '../projects/project-events.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { RedisService } from '../redis/redis.service.js';
import { ORIGIN } from '../test/auth-app.js';
import { type CompileTestApp, createCompileTestApp } from '../test/compile-app.js';
import { TEST_USER_HEADER } from '../test/projects-app.js';
import { SubmissionsModule } from './submissions.module.js';

const MAIN = '\\documentclass{article}\n\\begin{document}\n\\input{ch2}\n\\end{document}\n';
const CH2 = 'Chapitre 2\nLes débits baissent.\nFin.\n';

const success = (overrides: Partial<CompileResult> = {}): CompileResult => ({
  outcome: 'success',
  durationMs: 1800,
  issues: [],
  errorCount: 0,
  warningCount: 0,
  pdfBytes: 5,
  log: true,
  synctex: false,
  worker: 'worker-1',
  ...overrides,
});

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

describe('submissions', () => {
  let ctx: CompileTestApp;
  let student: User;
  let editor: User;
  let supervisor: User;
  let coSupervisor: User;
  let reviewer: User;
  let reader: User;
  let stranger: User;
  let projectId: string;

  const as = (user: User) => {
    const server = () => request(ctx.app.getHttpServer());
    const write = (req: request.Test) => req.set('Origin', ORIGIN).set(TEST_USER_HEADER, user.id);
    const base = `/api/projects/${projectId}/submissions`;
    return {
      get: (path = '') => server().get(`${base}${path}`).set(TEST_USER_HEADER, user.id),
      post: (path = '', body: object = {}) => write(server().post(`${base}${path}`)).send(body),
      patch: (path: string, body: object) => write(server().patch(`${base}${path}`)).send(body),
      delete: (path: string) => write(server().delete(`${base}${path}`)).send({}),
    };
  };

  const fileAt = (path: string) =>
    ctx.db.files.find((file) => file.projectId === projectId && file.path === path);
  const textAt = (path: string) =>
    new TextDecoder().decode(ctx.storage.objects.get(`projects/${fileAt(path)!.storageKey}`));

  /** Writes a file as the editor would (new object, then the row). */
  const write = async (path: string, text: string) => {
    const storageKey = `${projectId}/${randomUUID()}`;
    await ctx.storage.put('projects', storageKey, new TextEncoder().encode(text));
    const file = fileAt(path);
    if (file) {
      file.storageKey = storageKey;
      file.sizeBytes = text.length;
    } else {
      await ctx.db.client.projectFile.create({
        data: { projectId, path, kind: 'TEXT', storageKey, sizeBytes: text.length },
      });
    }
  };

  const draft = async (body: object = {}) =>
    (
      await as(student)
        .post('', {
          title: 'Chapitre 2 — Méthodologie',
          filePaths: ['ch2.tex'],
          reviewerIds: [supervisor.id, reviewer.id],
          ...body,
        })
        .expect(201)
    ).body as SubmissionDetail;

  const detail = async (id: string, user: User = student) =>
    (await as(user).get(`/${id}`).expect(200)).body as SubmissionDetail;

  /** The worker finishing the compilation of the sending being compiled. */
  const finishSending = async (id: string, result: CompileResult = success()) => {
    const version = ctx.db.submissionVersions.find(
      (row) => row.submissionId === id && row.state === 'COMPILING',
    )!;
    const compilation = ctx.db.compilations.find((row) => row.submissionVersionId === version.id)!;
    if (result.pdfBytes) {
      await ctx.storage.put(
        'compile-output',
        `${projectId}/${compilation.id}/output.pdf`,
        Buffer.from('%PDF-'),
      );
    }
    await ctx.queue.handlers!.completed(compilation.id, result);
    return compilation;
  };

  const send = async (id: string, filePaths = ['ch2.tex'], message: string | null = 'Relu ?') => {
    await as(student).post(`/${id}/send`, { filePaths, message }).expect(201);
    await finishSending(id);
    return detail(id);
  };

  const actions = (id: string) =>
    ctx.db.audits.filter((row) => row.targetId === id).map((row) => row.action);

  beforeAll(async () => {
    ctx = await createCompileTestApp({ SUBMISSION_COMPILES_PER_HOUR: '4' }, [
      HistoryModule,
      SubmissionsModule,
      CollabModule,
    ]);
  });

  beforeEach(async () => {
    ctx.db.reset();
    ctx.queue.reset();
    ctx.storage.objects.clear();
    await ctx.app.get(RedisService).client.flushdb();
    student = ctx.db.addUser('Awa Kaboré');
    editor = ctx.db.addUser('Issa Traoré');
    supervisor = ctx.db.addUser('Pr Ouédraogo');
    coSupervisor = ctx.db.addUser('Dr Sawadogo');
    reviewer = ctx.db.addUser('Relecteur');
    reader = ctx.db.addUser('Lecteur');
    stranger = ctx.db.addUser('Inconnu');
    const project = await ctx.db.client.project.create({
      data: { ownerId: student.id, name: 'Mémoire de master' },
    });
    projectId = project.id;
    await write('main.tex', MAIN);
    await write('ch2.tex', CH2);
    ctx.db.share(projectId, editor.id, 'EDITOR');
    ctx.db.share(projectId, supervisor.id, 'SUPERVISOR');
    ctx.db.share(projectId, coSupervisor.id, 'SUPERVISOR');
    ctx.db.share(projectId, reviewer.id, 'REVIEWER');
    ctx.db.share(projectId, reader.id, 'VIEWER');
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  describe('drafts', () => {
    it('are prepared by the owner and editors, with reviewers among supervisors and reviewers', async () => {
      const created = await draft({ dueAt: '2026-12-14T17:00:00.000Z', message: 'Bonjour' });
      expect(created).toMatchObject({
        title: 'Chapitre 2 — Méthodologie',
        status: 'DRAFT',
        dueAt: '2026-12-14T17:00:00.000Z',
        filePaths: ['ch2.tex'],
        message: 'Bonjour',
        lastNumber: null,
        versions: [],
        can: { edit: true, send: true, delete: true, validate: false },
      });
      expect(created.reviewers.map((item) => item.name)).toEqual(['Pr Ouédraogo', 'Relecteur']);
      await as(editor)
        .post('', { reviewerIds: [supervisor.id] })
        .expect(201);

      for (const user of [supervisor, reviewer, reader]) {
        await as(user).post('', {}).expect(403);
      }
      await as(stranger).get('').expect(404);
      await as(student)
        .post('', { reviewerIds: [reader.id] })
        .expect(422, {
          code: 'reviewer_invalid',
        });
      await as(student)
        .post('', { reviewerIds: [editor.id] })
        .expect(422);
      await as(student)
        .post('', { filePaths: ['missing.tex'] })
        .expect(422, {
          code: 'files_invalid',
        });
      await as(student)
        .post('', { title: 'x'.repeat(121) })
        .expect(400);

      const list = (await as(reader).get('').expect(200)).body as SubmissionList;
      expect(list.submissions).toHaveLength(2);
      expect(list.canCreate).toBe(false);
      expect(list.candidates.map((item) => [item.name, item.role])).toEqual([
        ['Pr Ouédraogo', 'SUPERVISOR'],
        ['Dr Sawadogo', 'SUPERVISOR'],
        ['Relecteur', 'REVIEWER'],
      ]);
    });

    it('are changed and deleted while not sent', async () => {
      const created = await draft();
      const changed = (
        await as(student)
          .patch(`/${created.id}`, {
            title: '',
            reviewerIds: [coSupervisor.id, supervisor.id],
            filePaths: ['main.tex', 'ch2.tex'],
          })
          .expect(200)
      ).body as SubmissionDetail;
      expect(changed.title).toBeNull();
      expect(changed.filePaths).toEqual(['main.tex', 'ch2.tex']);
      expect(changed.reviewers.map((item) => item.name).sort()).toEqual([
        'Dr Sawadogo',
        'Pr Ouédraogo',
      ]);
      await as(supervisor).patch(`/${created.id}`, { title: 'x' }).expect(403);
      await as(student).delete(`/${created.id}`).expect(204);
      await as(student).get(`/${created.id}`).expect(404);
    });
  });

  describe('sending', () => {
    it('freezes and compiles the version sent, without the cache or the hourly limit', async () => {
      ctx.db.plans.find((plan) => plan.code === 'FREE')!.maxCompilesPerHour = 1;
      // The hourly limit of the owner is used up by a compilation of the project.
      await request(ctx.app.getHttpServer())
        .post(`/api/projects/${projectId}/compile`)
        .set('Origin', ORIGIN)
        .set(TEST_USER_HEADER, student.id)
        .send({})
        .expect(201);
      const created = await draft();
      const sent = (
        await as(student)
          .post(`/${created.id}/send`, { filePaths: ['ch2.tex'], message: 'Chapitre prêt' })
          .expect(201)
      ).body as SubmissionDetail;
      // Nothing moves before the PDF of the frozen version is ready.
      expect(sent).toMatchObject({ status: 'DRAFT', sending: true, can: { send: false } });
      expect(sent.versions[0]).toMatchObject({
        number: null,
        state: 'COMPILING',
        filePaths: ['ch2.tex'],
        message: 'Chapitre prêt',
        files: [{ path: 'ch2.tex', sha256: sha(CH2) }],
      });
      const frozen = ctx.db.versions.find((row) => row.kind === 'SUBMISSION')!;
      expect(frozen.label).toBe('Chapitre 2 — Méthodologie');
      const job = [...ctx.queue.jobs.values()].find(
        (item) => item.data.compilationId === sent.versions[0]!.compilation!.id,
      )!;
      expect(job.data).toMatchObject({ cache: false, mainFile: 'main.tex', timeoutSeconds: 20 });
      expect(job.data.files.map((file) => file.path).sort()).toEqual(['ch2.tex', 'main.tex']);
      expect(job.data.files.every((file) => file.url.includes('/history/'))).toBe(true);
      // Changes made after the sending are not in what is compiled.
      await write('ch2.tex', 'Autre texte\n');
      await as(student)
        .post(`/${created.id}/send`, { filePaths: ['ch2.tex'] })
        .expect(409, {
          code: 'submission_busy',
        });

      await finishSending(created.id);
      const ready = await detail(created.id);
      expect(ready).toMatchObject({ status: 'SUBMITTED', lastNumber: 1, sending: false });
      expect(ready.versions[0]).toMatchObject({ number: 1, state: 'READY' });
      expect(ready.versions[0]!.compilation!.pdf).not.toBeNull();
      expect(ready.submittedAt).not.toBeNull();
      expect(ready.events.map((event) => [event.action, event.number])).toEqual([
        ['SUBMISSION_SENT', 1],
      ]);
      const audit = ctx.db.audits.find((row) => row.action === 'SUBMISSION_SENT')!;
      expect(audit).toMatchObject({ actorId: student.id, targetType: 'Submission' });
      expect(audit.metadata).toMatchObject({ projectId, number: 1, status: 'SUBMITTED' });
    });

    it('never shows the PDF of a submission as the project PDF, and keeps it', async () => {
      const created = await draft();
      const sent = await send(created.id);
      const frozenId = sent.versions[0]!.compilation!.id;
      const compile = ctx.app.get(CompileService);
      expect((await compile.state(student.id, projectId)).lastPdf).toBeNull();
      expect(await compile.publicPdf(projectId, 'x')).toBeNull();
      for (let round = 0; round < 3; round++) {
        const started = await compile.start(student.id, projectId, false);
        await ctx.storage.put(
          'compile-output',
          `${projectId}/${started.id}/output.pdf`,
          Buffer.from('%PDF'),
        );
        await ctx.queue.handlers!.completed(started.id, success());
      }
      expect(ctx.db.compilations.find((row) => row.id === frozenId)!.pdfKey).not.toBeNull();
      expect(ctx.storage.objects.has(`compile-output/${projectId}/${frozenId}/output.pdf`)).toBe(
        true,
      );
    });

    it('is refused without a PDF: back to draft with the errors; TeX errors with a PDF pass', async () => {
      const created = await draft();
      await as(student)
        .post(`/${created.id}/send`, { filePaths: ['ch2.tex'] })
        .expect(201);
      await finishSending(
        created.id,
        success({ outcome: 'tex_errors', pdfBytes: null, errorCount: 1 }),
      );
      const failed = await detail(created.id);
      expect(failed).toMatchObject({ status: 'DRAFT', lastNumber: null, can: { send: true } });
      expect(failed.versions[0]).toMatchObject({ number: null, state: 'FAILED' });
      expect(failed.versions[0]!.compilation).toMatchObject({
        outcome: 'tex_errors',
        errorCount: 1,
      });
      expect(actions(created.id)).toEqual([]);
      // The frozen version becomes an ordinary one of the history.
      expect(ctx.db.versions.filter((row) => row.kind === 'SUBMISSION')).toHaveLength(0);

      await as(student)
        .post(`/${created.id}/send`, { filePaths: ['ch2.tex'] })
        .expect(201);
      await finishSending(created.id, success({ outcome: 'tex_errors', errorCount: 2 }));
      expect(await detail(created.id)).toMatchObject({ status: 'SUBMITTED', lastNumber: 1 });
    });

    it('never stays stuck: a missed result or a lost sending is finished on reading', async () => {
      const created = await draft();
      const sent = (
        await as(student)
          .post(`/${created.id}/send`, { filePaths: ['ch2.tex'] })
          .expect(201)
      ).body as SubmissionDetail;
      // The compilation ended but its result was never applied to the sending.
      const compilation = ctx.db.compilations.find(
        (row) => row.id === sent.versions[0]!.compilation!.id,
      )!;
      Object.assign(compilation, { status: 'SUCCEEDED', pdfKey: 'k', finishedAt: new Date() });
      expect(await detail(created.id)).toMatchObject({ status: 'SUBMITTED', lastNumber: 1 });

      // A sending left without compilation by a crash is refused after a minute.
      await as(reviewer).post(`/${created.id}/open`).expect(201);
      await as(reviewer).post(`/${created.id}/feedback`).expect(201);
      const version = await ctx.db.client.submissionVersion.create({
        data: {
          submissionId: created.id,
          projectVersionId: ctx.db.versions[0]!.id,
          sentById: student.id,
        },
      });
      ctx.db.submissionVersions.find((row) => row.id === version.id)!.createdAt = new Date(
        Date.now() - 120_000,
      );
      await as(student)
        .post(`/${created.id}/send`, { filePaths: ['ch2.tex'] })
        .expect(201);
      expect(ctx.db.submissionVersions.find((row) => row.id === version.id)!.state).toBe('FAILED');
    });

    it('needs a reviewer still on the project, chosen files, and 3 sendings per hour at most', async () => {
      const created = await draft({ reviewerIds: [reviewer.id] });
      ctx.db.members = ctx.db.members.filter((m) => m.userId !== reviewer.id);
      await as(student)
        .post(`/${created.id}/send`, { filePaths: ['ch2.tex'] })
        .expect(422, {
          code: 'no_reviewer',
        });
      ctx.db.share(projectId, reviewer.id, 'REVIEWER');
      await as(student).post(`/${created.id}/send`, { filePaths: [] }).expect(400);
      await as(student)
        .post(`/${created.id}/send`, { filePaths: ['nope.tex'] })
        .expect(422);
      await as(supervisor)
        .post(`/${created.id}/send`, { filePaths: ['ch2.tex'] })
        .expect(403);

      for (let round = 0; round < 3; round++) {
        await as(student)
          .post(`/${created.id}/send`, { filePaths: ['ch2.tex'] })
          .expect(201);
        await finishSending(created.id, success({ outcome: 'no_pdf', pdfBytes: null }));
      }
      const refused = await as(student)
        .post(`/${created.id}/send`, { filePaths: ['ch2.tex'] })
        .expect(429);
      expect(refused.body.code).toBe('rate_limited');
    });

    it('caps the sendings of one account across its projects (configuration)', async () => {
      const created = await draft();
      for (let round = 0; round < 3; round++) {
        await as(student)
          .post(`/${created.id}/send`, { filePaths: ['ch2.tex'] })
          .expect(201);
        await finishSending(created.id, success({ outcome: 'no_pdf', pdfBytes: null }));
      }
      // Another project of the same owner.
      const first = projectId;
      projectId = (
        await ctx.db.client.project.create({ data: { ownerId: student.id, name: 'Rapport' } })
      ).id;
      await write('main.tex', MAIN);
      await write('ch2.tex', CH2);
      ctx.db.share(projectId, supervisor.id, 'SUPERVISOR');
      const other = await draft({ reviewerIds: [supervisor.id] });
      await as(student)
        .post(`/${other.id}/send`, { filePaths: ['ch2.tex'] })
        .expect(201);
      await finishSending(other.id, success({ outcome: 'no_pdf', pdfBytes: null }));
      const refused = await as(student)
        .post(`/${other.id}/send`, { filePaths: ['ch2.tex'] })
        .expect(429);
      expect(refused.body.code).toBe('submission_compile_limit');
      expect(refused.body.retryAfter).toBeGreaterThan(0);
      projectId = first;
    });
  });

  describe('review and validation', () => {
    it('goes from draft to validated, with a corrected version and a comparison', async () => {
      const created = await draft({ reviewerIds: [supervisor.id, reviewer.id] });
      await send(created.id);

      // Opened by a reviewer: in review (once); opened by others: nothing changes.
      await as(student).post(`/${created.id}/open`).expect(201);
      expect((await detail(created.id)).status).toBe('SUBMITTED');
      const opened = (await as(reviewer).post(`/${created.id}/open`).expect(201))
        .body as SubmissionDetail;
      expect(opened).toMatchObject({ status: 'IN_REVIEW', isReviewer: true });
      expect(opened.can).toMatchObject({ feedback: true, validate: false, unlock: false });
      await as(supervisor).post(`/${created.id}/open`).expect(201);
      expect(actions(created.id)).toEqual(['SUBMISSION_SENT', 'SUBMISSION_REVIEW_STARTED']);

      // A reviewer sends feedback but never validates; the student cannot do either.
      await as(reviewer).post(`/${created.id}/validate`, { number: 1 }).expect(403);
      await as(student).post(`/${created.id}/feedback`).expect(403);
      await as(student)
        .post(`/${created.id}/send`, { filePaths: ['ch2.tex'] })
        .expect(409, {
          code: 'submission_state',
        });
      await as(reviewer).post(`/${created.id}/feedback`).expect(201);
      expect((await detail(created.id)).status).toBe('FEEDBACK_SENT');

      // Corrected version: v2, REVISED.
      await write('ch2.tex', 'Chapitre 2\nLes débits baissent de 38 %.\nFin.\n');
      const revised = await send(created.id, ['ch2.tex', 'main.tex'], 'Corrigé');
      expect(revised).toMatchObject({ status: 'REVISED', lastNumber: 2 });
      expect(revised.versions.map((version) => version.number)).toEqual([2, 1]);

      const comparison = (
        await as(supervisor).get(`/${created.id}/compare?from=1&to=2`).expect(200)
      ).body as SubmissionComparison;
      expect(comparison.files.map((file) => [file.path, file.change])).toEqual([
        ['ch2.tex', 'modified'],
        ['main.tex', 'same'],
      ]);
      expect(comparison.files[0]).toMatchObject({ added: 1, removed: 1, tooLarge: false });
      expect(comparison.files[0]!.hunks[0]!.lines.filter((line) => line.type !== 'same')).toEqual([
        {
          type: 'removed',
          text: 'Les débits baissent.',
          from: 2,
          to: null,
          segments: [{ text: 'Les débits baissent.', changed: false }],
        },
        {
          type: 'added',
          text: 'Les débits baissent de 38 %.',
          from: null,
          to: 2,
          segments: [
            { text: 'Les débits baissent', changed: false },
            { text: ' de 38 %', changed: true },
            { text: '.', changed: false },
          ],
        },
      ]);
      await as(supervisor).get(`/${created.id}/compare?from=1&to=3`).expect(404);

      await as(supervisor).post(`/${created.id}/open`).expect(201);
      // Only a supervisor among the reviewers validates, and only the version read.
      await as(coSupervisor).post(`/${created.id}/validate`, { number: 2 }).expect(403);
      await as(supervisor).post(`/${created.id}/validate`, { number: 1 }).expect(409, {
        code: 'version_changed',
      });
      const validated = (
        await as(supervisor).post(`/${created.id}/validate`, { number: 2 }).expect(201)
      ).body as SubmissionDetail;
      expect(validated).toMatchObject({
        status: 'VALIDATED',
        validatedNumber: 2,
        validatedBy: { name: 'Pr Ouédraogo' },
        can: { unlock: true, feedback: false, validate: false, setDue: false },
      });
      expect(fileAt('ch2.tex')!.lockedBySubmissionId).toBe(created.id);
      expect(fileAt('main.tex')!.lockedBySubmissionId).toBe(created.id);
      // Notified in the application (and by SMS): reviewers on each sending, the author on
      // feedback and validation.
      const notices = ctx.db.notifications.filter((row) => row.channel === 'IN_APP');
      expect(notices.map((row) => [row.type, row.userId])).toEqual([
        ['SUBMISSION_RECEIVED', supervisor.id],
        ['SUBMISSION_RECEIVED', reviewer.id],
        ['SUBMISSION_FEEDBACK', student.id],
        ['SUBMISSION_RECEIVED', supervisor.id],
        ['SUBMISSION_RECEIVED', reviewer.id],
        ['SUBMISSION_VALIDATED', student.id],
      ]);
      expect(ctx.db.records).toEqual([
        expect.objectContaining({
          submissionId: created.id,
          validatedById: supervisor.id,
          files: [
            { path: 'ch2.tex', sha256: sha('Chapitre 2\nLes débits baissent de 38 %.\nFin.\n') },
            { path: 'main.tex', sha256: sha(MAIN) },
          ],
        }),
      ]);
      expect(actions(created.id)).toEqual([
        'SUBMISSION_SENT',
        'SUBMISSION_REVIEW_STARTED',
        'SUBMISSION_FEEDBACK_SENT',
        'SUBMISSION_SENT',
        'SUBMISSION_REVIEW_STARTED',
        'SUBMISSION_VALIDATED',
      ]);
      await as(supervisor).post(`/${created.id}/validate`, { number: 2 }).expect(409);

      // Locked: no change through the API, no restoration.
      await request(ctx.app.getHttpServer())
        .put(`/api/projects/${projectId}/files/upload?path=ch2.tex&replace=true`)
        .set('Origin', ORIGIN)
        .set(TEST_USER_HEADER, student.id)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('changé'))
        .expect(409, { code: 'file_locked' });
      const before = ctx.db.versions.find((row) => row.kind === 'SUBMISSION')!;
      const restored = await request(ctx.app.getHttpServer())
        .post(`/api/projects/${projectId}/versions/${before.id}/restore`)
        .set('Origin', ORIGIN)
        .set(TEST_USER_HEADER, student.id)
        .send({})
        .expect(201);
      expect(restored.body.kept).toEqual(['ch2.tex']);
      expect(textAt('ch2.tex')).toBe('Chapitre 2\nLes débits baissent de 38 %.\nFin.\n');
      // ... nor through the collaboration server.
      const collab = ctx.app.get(CollabDocsService);
      const stored = await collab.store({
        projectId,
        fileId: fileAt('ch2.tex')!.id,
        state: '',
        text: 'changé',
        baseKey: fileAt('ch2.tex')!.storageKey,
      });
      expect(stored.code).toBe('file_locked');
    });

    it('puts back the files sent when they changed since, after saving them as a version', async () => {
      const created = await draft({ reviewerIds: [supervisor.id] });
      await send(created.id);
      await write('ch2.tex', 'Brouillon de la suite\n');
      await as(supervisor).post(`/${created.id}/open`).expect(201);
      expect((await detail(created.id, supervisor)).changedSinceSent).toEqual(['ch2.tex']);
      expect((await detail(created.id, student)).changedSinceSent).toEqual([]);

      const publish = vi.spyOn(ctx.app.get(ProjectEventsService), 'publish');
      const validated = (
        await as(supervisor).post(`/${created.id}/validate`, { number: 1 }).expect(201)
      ).body as SubmissionDetail;
      // The open editors of the locked files drop what they did not store.
      expect(publish).toHaveBeenCalledWith({
        type: 'file-locked',
        projectId,
        fileId: fileAt('ch2.tex')!.id,
      });
      publish.mockRestore();
      expect(textAt('ch2.tex')).toBe(CH2);
      const saved = ctx.db.versions.find((row) => row.label === 'Avant validation')!;
      expect(saved.kind).toBe('NAMED');
      const manifest = JSON.parse(
        new TextDecoder().decode(ctx.storage.objects.get(`projects/${saved.storageKey}`)),
      ) as { files: { path: string; blob: string }[] };
      const blob = manifest.files.find((file) => file.path === 'ch2.tex')!.blob;
      expect(
        new TextDecoder().decode(ctx.storage.objects.get(`projects/${projectId}/history/${blob}`)),
      ).toBe('Brouillon de la suite\n');
      expect(validated.events.at(-1)).toMatchObject({
        action: 'SUBMISSION_VALIDATED',
        number: 1,
        restored: ['ch2.tex'],
        beforeVersionId: saved.id,
        beforeVersionLabel: 'Avant validation',
      });
      expect(
        (
          await request(ctx.app.getHttpServer())
            .get(`/api/projects/${projectId}`)
            .set(TEST_USER_HEADER, student.id)
            .expect(200)
        ).body.files.find((file: { path: string }) => file.path === 'ch2.tex'),
      ).toMatchObject({ locked: true, lockedBy: created.id });
    });

    it('follows a file moved after sending: the file itself is put back and locked', async () => {
      const created = await draft({ reviewerIds: [supervisor.id] });
      await send(created.id);
      const ch2 = fileAt('ch2.tex')!;
      const server = () => request(ctx.app.getHttpServer());
      await server()
        .patch(`/api/projects/${projectId}/files/${ch2.id}`)
        .set('Origin', ORIGIN)
        .set(TEST_USER_HEADER, student.id)
        .send({ path: 'chapitres/ch2.tex' })
        .expect(200);
      await write('chapitres/ch2.tex', 'Réécrit après le déplacement\n');
      await as(supervisor).post(`/${created.id}/open`).expect(201);
      expect((await detail(created.id, supervisor)).changedSinceSent).toEqual(['ch2.tex']);

      await as(supervisor).post(`/${created.id}/validate`, { number: 1 }).expect(201);
      // No copy at the old path: the moved file takes the validated text and is locked.
      expect(fileAt('ch2.tex')).toBeUndefined();
      const moved = fileAt('chapitres/ch2.tex')!;
      expect(moved.id).toBe(ch2.id);
      expect(moved.lockedBySubmissionId).toBe(created.id);
      expect(textAt('chapitres/ch2.tex')).toBe(CH2);
      // The trace keeps the paths and hashes sent, nothing else.
      expect(ctx.db.records[0]!.files).toEqual([{ path: 'ch2.tex', sha256: sha(CH2) }]);
    });

    it('lets a draft follow its files when they move', async () => {
      const created = await draft();
      const ch2 = fileAt('ch2.tex')!;
      await request(ctx.app.getHttpServer())
        .patch(`/api/projects/${projectId}/folders`)
        .set('Origin', ORIGIN)
        .set(TEST_USER_HEADER, editor.id)
        .send({ from: 'chapitres', to: 'x' })
        .expect(404);
      await request(ctx.app.getHttpServer())
        .patch(`/api/projects/${projectId}/files/${ch2.id}`)
        .set('Origin', ORIGIN)
        .set(TEST_USER_HEADER, editor.id)
        .send({ path: 'parties/ch2.tex' })
        .expect(200);
      expect((await detail(created.id)).filePaths).toEqual(['parties/ch2.tex']);
      await send(created.id, ['parties/ch2.tex']);
    });

    it('is unlocked by a supervisor: the submission stays validated, the trace is kept', async () => {
      const created = await draft({ reviewerIds: [supervisor.id, reviewer.id] });
      await send(created.id);
      await as(supervisor).post(`/${created.id}/open`).expect(201);
      await as(supervisor).post(`/${created.id}/validate`, { number: 1 }).expect(201);
      await as(reviewer).post(`/${created.id}/unlock`).expect(403);
      await as(student).post(`/${created.id}/unlock`).expect(403);
      const unlocked = (await as(supervisor).post(`/${created.id}/unlock`).expect(201))
        .body as SubmissionDetail;
      expect(unlocked).toMatchObject({
        status: 'VALIDATED',
        unlockedBy: { name: 'Pr Ouédraogo' },
        can: { unlock: false, send: false },
      });
      expect(fileAt('ch2.tex')!.lockedBySubmissionId).toBeNull();
      expect(ctx.db.records).toHaveLength(1);
      expect(actions(created.id).at(-1)).toBe('SUBMISSION_UNLOCKED');
      await as(supervisor).post(`/${created.id}/unlock`).expect(409);
    });

    it('never changes nor takes over files validated by another submission', async () => {
      const first = await draft({ reviewerIds: [supervisor.id] });
      const second = await draft({ reviewerIds: [supervisor.id] });
      await send(first.id);
      await send(second.id);
      await as(supervisor).post(`/${first.id}/open`).expect(201);
      await as(supervisor).post(`/${second.id}/open`).expect(201);
      await as(supervisor).post(`/${first.id}/validate`, { number: 1 }).expect(201);
      await as(supervisor).post(`/${second.id}/validate`, { number: 1 }).expect(409, {
        code: 'file_locked',
      });
      expect(fileAt('ch2.tex')!.lockedBySubmissionId).toBe(first.id);
      expect((await detail(second.id)).status).toBe('IN_REVIEW');
    });

    it('changes no file when the validation is refused', async () => {
      const created = await draft({ reviewerIds: [supervisor.id] });
      await send(created.id);
      await write('ch2.tex', 'Suite\n');
      await as(supervisor).post(`/${created.id}/open`).expect(201);
      const key = fileAt('ch2.tex')!.storageKey;
      ctx.db.failNextAudit = true;
      await as(supervisor).post(`/${created.id}/validate`, { number: 1 }).expect(500);
      expect(fileAt('ch2.tex')!.storageKey).toBe(key);
      expect(textAt('ch2.tex')).toBe('Suite\n');
      expect(fileAt('ch2.tex')!.lockedBySubmissionId).toBeNull();
      expect(ctx.db.records).toEqual([]);
      expect((await detail(created.id)).status).toBe('IN_REVIEW');
    });

    it('lets a supervisor among the reviewers change the deadline once sent', async () => {
      const created = await draft({ reviewerIds: [supervisor.id, reviewer.id] });
      await as(supervisor)
        .patch(`/${created.id}/due`, { dueAt: '2026-12-20T17:00:00.000Z' })
        .expect(409);
      await send(created.id);
      await as(reviewer).patch(`/${created.id}/due`, { dueAt: null }).expect(403);
      await as(student).patch(`/${created.id}/due`, { dueAt: null }).expect(403);
      const changed = (
        await as(supervisor)
          .patch(`/${created.id}/due`, { dueAt: '2026-12-20T17:00:00.000Z' })
          .expect(200)
      ).body as SubmissionDetail;
      expect(changed.dueAt).toBe('2026-12-20T17:00:00.000Z');
      expect(changed.events.at(-1)).toMatchObject({
        action: 'SUBMISSION_DUE_CHANGED',
        dueAt: '2026-12-20T17:00:00.000Z',
        actor: { name: 'Pr Ouédraogo' },
      });
    });
  });

  it('lists the submissions to review of a user, nearest deadline first', async () => {
    const late = await draft({ dueAt: '2026-12-30T00:00:00.000Z' });
    const soon = await draft({ dueAt: '2026-12-01T00:00:00.000Z', reviewerIds: [supervisor.id] });
    const unsent = await draft();
    await send(late.id);
    await send(soon.id);
    const list = (
      await request(ctx.app.getHttpServer())
        .get('/api/submissions/to-review')
        .set(TEST_USER_HEADER, supervisor.id)
        .expect(200)
    ).body as ToReviewList;
    expect(list.submissions.map((item) => item.id)).toEqual([soon.id, late.id]);
    expect(list.submissions[0]).toMatchObject({ projectName: 'Mémoire de master', lastNumber: 1 });
    expect(list.submissions.map((item) => item.id)).not.toContain(unsent.id);
    const forReviewer = (
      await request(ctx.app.getHttpServer())
        .get('/api/submissions/to-review')
        .set(TEST_USER_HEADER, reviewer.id)
        .expect(200)
    ).body as ToReviewList;
    expect(forReviewer.submissions.map((item) => item.id)).toEqual([late.id]);
    // A supervisor whose access was removed has nothing left to review there.
    ctx.db.members = ctx.db.members.filter((m) => m.userId !== supervisor.id);
    const after = await request(ctx.app.getHttpServer())
      .get('/api/submissions/to-review')
      .set(TEST_USER_HEADER, supervisor.id)
      .expect(200);
    expect(after.body.submissions).toEqual([]);
  });

  it('keeps only the trace of validations when the project is erased', async () => {
    const created = await draft({ reviewerIds: [supervisor.id] });
    await send(created.id);
    await as(supervisor).post(`/${created.id}/open`).expect(201);
    await as(supervisor).post(`/${created.id}/validate`, { number: 1 }).expect(201);
    expect(await ctx.app.get(ProjectsService).erase(projectId)).toBe(true);
    expect(ctx.db.submissions).toEqual([]);
    expect(ctx.db.submissionVersions).toEqual([]);
    expect(ctx.db.records).toEqual([
      expect.objectContaining({
        submissionId: created.id,
        files: [{ path: 'ch2.tex', sha256: sha(CH2) }],
      }),
    ]);
  });
});
