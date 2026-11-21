import {
  COMPILE_OUTPUT_BUCKET,
  EXAM_PAPERS_BUCKET,
  PRINT_LINK_TTL_SECONDS,
  TEMPLATES_BUCKET,
} from '@integris/shared';
import { zipSync } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CompileQueueService } from '../compile/compile-queue.service.js';
import { ApiConfig } from '../config/api-config.js';
import { CompileService, type FrozenHooks } from '../compile/compile.service.js';
import { examLinkKey, verifyExamLink } from '../files/file-links.js';
import { HistoryService } from '../history/history.service.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { type BillingTestApp, createBillingTestApp } from '../test/billing-app.js';
import { TEST_USER_HEADER } from '../test/projects-app.js';
import { TemplatesService } from '../projects/templates.service.js';
import { ExamPapersModule } from './exam-papers.module.js';
import { SecretariatService } from './secretariat.service.js';

const ORIGIN = 'http://127.0.0.1:3000';
const DAY_MS = 86_400_000;
type Row = Record<string, unknown>;

/** The compilation, as the exam papers module sees it: frozen jobs recorded, finished by hand. */
class FakeCompile {
  hooks = new Map<string, FrozenHooks>();
  started: { mainFile: string; files: { path: string }[]; row: Row }[] = [];
  constructor(private readonly db: () => BillingTestApp['db']) {}
  registerFrozen(kind: string, hooks: FrozenHooks) {
    this.hooks.set(kind, hooks);
  }
  async startFrozen(input: {
    projectId: string;
    engine: string;
    frozen: Row;
    mainFile: string;
    files: { path: string }[];
  }) {
    const row = this.db().insert('compilation', {
      projectId: input.projectId,
      engine: input.engine,
      status: 'QUEUED',
      pdfKey: null,
      errors: null,
      submissionVersionId: null,
      printSendId: null,
      ...input.frozen,
    });
    this.started.push({ mainFile: input.mainFile, files: input.files, row });
    return row;
  }
  async refreshFrozen(row: Row) {
    return row;
  }
  async dropOutputs() {}
}

/** The history: a frozen version is the list of the project files at that moment. */
class FakeHistory {
  constructor(private readonly db: () => BillingTestApp['db']) {}
  async createVersion(projectId: string, kind: string) {
    const files = this.db().rows('projectFile', { projectId });
    return this.db().insert('projectVersion', {
      projectId,
      kind,
      storageKey: `manifest-${projectId}`,
      files: files.map((file) => ({ path: file.path, blob: file.id, sizeBytes: file.sizeBytes })),
    });
  }
  async readManifest(version: Row) {
    return { mainFilePath: 'sujet.tex', files: version.files, folders: [] };
  }
}

let t: BillingTestApp;
let compile: FakeCompile;
let secretariat: SecretariatService;
let seq = 0;
let org: Row;
let ufr: Row;
let l3: Row;
let m2: Row;
let owner: Row;
let admin: Row;
let teacher: Row;
let teacher2: Row;
let student: Row;
let secretary: Row;
let otherSecretary: Row;

const as = (who: Row) => {
  const server = () => request(t.app.getHttpServer());
  const id = who.id as string;
  return {
    get: (path: string) => server().get(`/api${path}`).set(TEST_USER_HEADER, id),
    post: (path: string, body: object = {}) =>
      server().post(`/api${path}`).set(TEST_USER_HEADER, id).set('Origin', ORIGIN).send(body),
    patch: (path: string, body: object) =>
      server().patch(`/api${path}`).set(TEST_USER_HEADER, id).set('Origin', ORIGIN).send(body),
    delete: (path: string) =>
      server().delete(`/api${path}`).set(TEST_USER_HEADER, id).set('Origin', ORIGIN).send({}),
    zip: (path: string, body: Uint8Array) =>
      server()
        .post(`/api${path}`)
        .set(TEST_USER_HEADER, id)
        .set('Origin', ORIGIN)
        .set('content-type', 'application/zip')
        .send(Buffer.from(body)),
  };
};

function person(name: string): Row {
  seq++;
  return t.db.addUser({
    displayName: `${name} ${seq}`,
    phone: `+22671${String(seq).padStart(6, '0')}`,
    phoneVerifiedAt: new Date(),
  });
}

function member(user: Row, kind: string, role = 'MEMBER', organization = org): Row {
  return t.db.insert('membership', {
    organizationId: organization.id,
    userId: user.id,
    role,
    kind,
    status: 'ACTIVE',
  });
}

/** A live BUSINESS with its groups (UFR SVT › L3, UFR SVT › M2). */
function business(name: string): Row {
  const organization = t.db.insert('organization', { type: 'BUSINESS', name });
  t.db.insert('subscription', {
    planId: 'BUSINESS',
    organizationId: organization.id,
    status: 'ACTIVE',
    billingPeriod: 'MONTHLY',
    seatCount: 20,
    currentPeriodStart: new Date(),
    currentPeriodEnd: new Date(Date.now() + 30 * DAY_MS),
  });
  return organization;
}

async function onePagePdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.addPage([595, 842]);
  return document.save();
}

const future = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString();

const sendBody = (groupId: string, availableInDays = 1) => ({
  title: 'Hydrologie — Examen',
  groupId,
  copies: 86,
  reserveCopies: 4,
  duplex: 'DUPLEX',
  stapled: true,
  availableFrom: future(availableInDays),
  examAt: future(3),
});

async function createPaper(who = teacher): Promise<string> {
  const response = await as(who).post('/exam-papers', { name: 'Hydrologie' }).expect(201);
  return response.body.id as string;
}

/** Sends a paper and finishes its compilation with a PDF: returns the request. */
async function sendAndCompile(projectId: string, body = sendBody(l3.id as string)) {
  await as(teacher).post(`/exam-papers/${projectId}/send`, body).expect(200);
  const job = compile.started.at(-1)!;
  const pdfKey = `${projectId}/${job.row.id}/output.pdf`;
  await t.storage.put(COMPILE_OUTPUT_BUCKET, pdfKey, await onePagePdf());
  await compile.hooks.get('print')!.finished({ ...job.row, pdfKey, status: 'SUCCEEDED' } as never);
  return t.db.rows('printRequest', { projectId }).at(-1)!;
}

/** Makes a request available now (as if its date had come). */
function reachDate(requestRow: Row) {
  requestRow.availableFrom = new Date(Date.now() - 1000);
}

beforeAll(async () => {
  const holder: { app?: BillingTestApp } = {};
  compile = new FakeCompile(() => holder.app!.db);
  holder.app = await createBillingTestApp(
    {},
    [OrganizationsModule, ExamPapersModule],
    [
      { token: CompileService, value: compile },
      { token: CompileQueueService, value: {} },
      { token: HistoryService, value: new FakeHistory(() => holder.app!.db) },
    ],
  );
  t = holder.app;
  secretariat = t.app.get(SecretariatService);
  // Registered at module init.
  expect(compile.hooks.has('print')).toBe(true);
});

afterAll(async () => {
  await t.app.close();
});

beforeEach(() => {
  t.db.reset();
  t.db.addPlans();
  t.storage.objects.clear();
  compile.started = [];
  org = business('Université test');
  ufr = t.db.insert('orgGroup', { organizationId: org.id, name: 'UFR SVT' });
  l3 = t.db.insert('orgGroup', { organizationId: org.id, name: 'L3', parentId: ufr.id });
  m2 = t.db.insert('orgGroup', { organizationId: org.id, name: 'M2', parentId: ufr.id });
  owner = person('Titulaire');
  admin = person('Admin');
  teacher = person('Enseignant');
  teacher2 = person('Enseignante');
  student = person('Étudiant');
  secretary = person('Secrétariat');
  otherSecretary = person('Secrétariat M2');
  member(owner, 'OTHER', 'OWNER');
  member(admin, 'TEACHER', 'ADMIN');
  member(teacher, 'TEACHER');
  member(teacher2, 'TEACHER');
  member(student, 'STUDENT');
  const scope = member(secretary, 'SECRETARY');
  t.db.insert('secretariatScope', { membershipId: scope.id, groupId: ufr.id });
  const other = member(otherSecretary, 'SECRETARY');
  t.db.insert('secretariatScope', { membershipId: other.id, groupId: m2.id });
});

describe('exam papers', () => {
  it('are created by active teachers of a live BUSINESS only, with three protected parts', async () => {
    await as(student).post('/exam-papers', { name: 'Devoir' }).expect(403, {
      code: 'exam_teacher_only',
    });
    const id = await createPaper();
    const project = t.db.rows('project', { id })[0]!;
    expect(project.kind).toBe('ASSIGNMENT');
    expect(project.mainFilePath).toBe('sujet.tex');
    const files = t.db.rows('projectFile', { projectId: id }).map((file) => file.path);
    expect(files.sort()).toEqual(['bareme.tex', 'corrige.tex', 'sujet.tex']);
    // Not listed with the documents; listed in "Mes devoirs".
    const projects = await as(teacher).get('/projects').expect(200);
    expect(projects.body.projects.map((p: Row) => p.id)).not.toContain(id);
    const list = await as(teacher).get('/exam-papers').expect(200);
    expect(list.body.canCreate).toBe(true);
    expect(list.body.papers.map((p: Row) => p.id)).toEqual([id]);
    // The answer key cannot be deleted; nobody shares it nor downloads it but the owner.
    const corrige = t.db.rows('projectFile', { projectId: id, path: 'corrige.tex' })[0]!;
    await as(teacher)
      .delete(`/projects/${id}/files/${corrige.id}`)
      .expect(409, { code: 'exam_part_protected' });
    const detail = await as(teacher).get(`/projects/${id}`).expect(200);
    expect(detail.body.rights).toMatchObject({ share: false, download: true, edit: true });
  });

  it('refuses a class that no secretariat serves', async () => {
    const lonely = t.db.insert('orgGroup', { organizationId: org.id, name: 'Autre UFR' });
    const id = await createPaper();
    await as(teacher)
      .post(`/exam-papers/${id}/send`, sendBody(lonely.id as string))
      .expect(409, { code: 'no_secretariat' });
    await as(teacher)
      .post(`/exam-papers/${id}/send`, { ...sendBody(l3.id as string), examAt: future(-1) })
      .expect(400, { code: 'exam_dates_invalid' });
  });

  it('compiles the subject alone and stores its frozen PDF in the private exam bucket', async () => {
    const id = await createPaper();
    const requestRow = await sendAndCompile(id);
    const job = compile.started.at(-1)!;
    expect(job.mainFile).toBe('sujet.tex');
    // The answer key and the marking scheme never reach the compilation.
    expect(job.files.map((file) => file.path)).toEqual(['sujet.tex']);
    expect(requestRow).toMatchObject({ status: 'SCHEDULED', pages: 1, copies: 86 });
    expect(await t.storage.exists(EXAM_PAPERS_BUCKET, requestRow.subjectPdfKey as string)).toBe(
      true,
    );
    const version = t.db.rows('projectVersion', { projectId: id })[0]!;
    expect(version.kind).toBe('PRINT');
    expect(t.db.rows('printEvent', { printRequestId: requestRow.id }).map((e) => e.type)).toEqual([
      'REQUESTED',
    ]);
  });

  it('records a failed compilation without creating a request', async () => {
    const id = await createPaper();
    await as(teacher)
      .post(`/exam-papers/${id}/send`, sendBody(l3.id as string))
      .expect(200);
    const job = compile.started.at(-1)!;
    await compile.hooks.get('print')!.finished({
      ...job.row,
      status: 'FAILED',
      errors: { outcome: 'tex_errors', issues: [] },
    } as never);
    const detail = await as(teacher).get(`/exam-papers/${id}`).expect(200);
    expect(detail.body.send).toMatchObject({ status: 'FAILED', outcome: 'tex_errors' });
    expect(t.db.rows('printRequest', { projectId: id })).toHaveLength(0);
  });
});

describe('print requests', () => {
  it('stay locked before their date for everyone, owner and admins included', async () => {
    const requestRow = await sendAndCompile(await createPaper());
    for (const who of [secretary, admin, owner, teacher]) {
      const response = await as(who).post(`/print-requests/${requestRow.id}/preview`).expect(403);
      expect(response.body.code).toBe('print_locked');
    }
    await as(secretary).post(`/print-requests/${requestRow.id}/print-link`).expect(403);
    // The files domain refuses too, whatever the link says.
    const now = Math.floor(Date.now() / 1000);
    const forged = await secretariat.serve(
      {
        kind: 'preview',
        requestId: requestRow.id as string,
        userId: secretary.id as string,
        linkId: null,
        issued: now,
        expires: now + 600,
      },
      '10.0.0.1',
    );
    expect(forged).toBeNull();
  });

  it('are seen by the secretariat of their groups only', async () => {
    const requestRow = await sendAndCompile(await createPaper());
    const queue = await as(secretary).get(`/organizations/${org.id}/print-queue`).expect(200);
    expect(queue.body.requests.map((r: Row) => r.id)).toEqual([requestRow.id]);
    const other = await as(otherSecretary).get(`/organizations/${org.id}/print-queue`).expect(200);
    expect(other.body.requests).toEqual([]);
    await as(otherSecretary).get(`/print-requests/${requestRow.id}`).expect(404);
    await as(student).get(`/print-requests/${requestRow.id}`).expect(404);
    await as(teacher).get(`/organizations/${org.id}/print-queue`).expect(403);
  });

  it('are changed or canceled until opened, and a new send replaces one not opened', async () => {
    const id = await createPaper();
    const first = await sendAndCompile(id);
    await as(teacher).patch(`/print-requests/${first.id}`, { copies: 90 }).expect(200);
    expect(first.copies).toBe(90);
    await as(teacher2).patch(`/print-requests/${first.id}`, { copies: 1 }).expect(404);
    const second = await sendAndCompile(id, {
      ...sendBody(l3.id as string),
      replacesId: first.id as string,
    } as never);
    expect(first).toMatchObject({ status: 'CANCELED', replacedById: second.id });
    const types = t.db.rows('printEvent', { printRequestId: first.id }).map((e) => e.type);
    expect(types).toEqual(['REQUESTED', 'UPDATED', 'CANCELED']);
    // Opened by the secretariat: no more change, only a cancellation.
    reachDate(second);
    await as(secretary).post(`/print-requests/${second.id}/preview`).expect(200);
    expect(second.status).toBe('OPENED');
    await as(teacher)
      .patch(`/print-requests/${second.id}`, { copies: 10 })
      .expect(409, { code: 'print_status' });
    await as(teacher).post(`/print-requests/${second.id}/cancel`).expect(204);
    expect(second.status).toBe('CANCELED');
  });

  it('open with a nominative watermark and print once through a 10-minute link', async () => {
    const requestRow = await sendAndCompile(await createPaper());
    reachDate(requestRow);
    // The admins never see the subject.
    await as(admin).post(`/print-requests/${requestRow.id}/preview`).expect(403);
    const preview = await as(secretary)
      .post(`/print-requests/${requestRow.id}/preview`)
      .expect(200);
    expect(preview.body.url).toMatch(/\/exam\/[\w-]+\.[\w-]+\/Hydrologie-Examen\.pdf$/);
    expect(requestRow.status).toBe('OPENED');
    const issued = Math.floor(Date.now() / 1000);
    const watermarked = await secretariat.serve(
      {
        kind: 'preview',
        requestId: requestRow.id as string,
        userId: secretary.id as string,
        linkId: 'opening-1',
        issued,
        expires: issued + 600,
      },
      '10.0.0.1',
    );
    const clean = await t.storage.get(EXAM_PAPERS_BUCKET, requestRow.subjectPdfKey as string);
    expect(watermarked).not.toBeNull();
    expect(Buffer.from(watermarked!).equals(Buffer.from(clean))).toBe(false);
    // The teacher sees the same preview after the date.
    await as(teacher).post(`/print-requests/${requestRow.id}/preview`).expect(200);

    const link = await as(secretary)
      .post(`/print-requests/${requestRow.id}/print-link`)
      .expect(200);
    const row = t.db.tables.printDownloadLink.at(-1)!;
    expect((row.expiresAt as Date).getTime() - Date.now()).toBeLessThanOrEqual(
      PRINT_LINK_TTL_SECONDS * 1000,
    );
    expect(link.body.url).toContain('/exam/');
    const print = {
      kind: 'print' as const,
      requestId: requestRow.id as string,
      userId: secretary.id as string,
      linkId: row.id as string,
      issued,
      expires: issued + PRINT_LINK_TTL_SECONDS,
    };
    expect(
      Buffer.from((await secretariat.serve(print, '10.0.0.2'))!).equals(Buffer.from(clean)),
    ).toBe(true);
    // Used once.
    expect(await secretariat.serve(print, '10.0.0.2')).toBeNull();
    // Another reader cannot use it.
    await as(secretary).post(`/print-requests/${requestRow.id}/print-link`).expect(200);
    const second = t.db.tables.printDownloadLink.at(-1)!;
    expect(
      await secretariat.serve(
        { ...print, linkId: second.id as string, userId: admin.id as string },
        null,
      ),
    ).toBeNull();

    await as(secretary).post(`/print-requests/${requestRow.id}/printed`, { count: 90 }).expect(200);
    await as(secretary)
      .post(`/print-requests/${requestRow.id}/handed-over`, { to: 'Pr. Surveillant' })
      .expect(200);
    expect(requestRow).toMatchObject({ status: 'HANDED_OVER', printedCount: 90 });
    const events = t.db.rows('printEvent', { printRequestId: requestRow.id });
    // One opening: the preview delivered to the secretariat (the teacher's link was not fetched).
    expect(events.map((event) => event.type)).toEqual([
      'REQUESTED',
      'OPENED',
      'DOWNLOADED',
      'PRINT_CONFIRMED',
      'HANDED_OVER',
    ]);
    expect(events.find((event) => event.type === 'DOWNLOADED')).toMatchObject({
      actorId: secretary.id,
      ip: '10.0.0.2',
    });
    // The teacher is told by SMS at printing and at handover (sent at step 14).
    const sms = t.db.rows('notification', { userId: teacher.id, channel: 'SMS' });
    expect(sms.map((n) => n.type)).toEqual(['PRINT_PRINTED', 'PRINT_HANDED_OVER']);
    // Journal: the teacher, the secretariat concerned and the admins see it.
    for (const who of [teacher, secretary, admin]) {
      const page = await as(who).get(`/print-requests/${requestRow.id}`).expect(200);
      expect(page.body.events).toHaveLength(5);
    }
    expect(events.find((event) => event.type === 'OPENED')).toMatchObject({
      actorId: secretary.id,
      ip: '10.0.0.1',
    });
    const journal = await as(admin).get(`/organizations/${org.id}/print-journal`).expect(200);
    expect(journal.body.events).toHaveLength(5);
  });

  it('journal one opening per preview link, however often the viewer fetches it', async () => {
    const requestRow = await sendAndCompile(await createPaper());
    reachDate(requestRow);
    /** The link the API gives, as the files domain reads it back (signature checked). */
    const open = async () => {
      const { body } = await as(secretary)
        .post(`/print-requests/${requestRow.id}/preview`)
        .expect(200);
      const token = /\/exam\/([^/]+)\//.exec(body.url as string)![1]!;
      const key = examLinkKey(t.app.get(ApiConfig).env.AUTH_SECRET);
      return verifyExamLink(key, token)!;
    };
    const openings = () =>
      t.db.rows('printEvent', { printRequestId: requestRow.id, type: 'OPENED' });

    // The viewer loads the same link twice at once (React strict mode), then again (retry).
    const first = await open();
    expect(first).toMatchObject({ kind: 'preview', linkId: expect.any(String) });
    const served = await Promise.all([
      secretariat.serve(first, '10.0.0.1'),
      secretariat.serve(first, '10.0.0.1'),
    ]);
    expect(served.every((pdf) => pdf !== null)).toBe(true);
    expect(await secretariat.serve(first, '10.0.0.1')).not.toBeNull();
    expect(openings()).toHaveLength(1);
    // Never one lost: the same link from another address, then a new opening, are journaled.
    expect(await secretariat.serve(first, '10.0.0.9')).not.toBeNull();
    expect(openings()).toHaveLength(2);
    const second = await open();
    expect(second.linkId).not.toBe(first.linkId);
    expect(await secretariat.serve(second, '10.0.0.1')).not.toBeNull();
    expect(
      openings().map((event) => [event.ip, (event.metadata as { opening: string }).opening]),
    ).toEqual([
      ['10.0.0.1', first.linkId],
      ['10.0.0.9', first.linkId],
      ['10.0.0.1', second.linkId],
    ]);
    // A preview link without its opening is refused.
    expect(await secretariat.serve({ ...first, linkId: null }, '10.0.0.1')).toBeNull();
    expect(openings()).toHaveLength(3);
  });

  it('become ready at their date and tell the secretariat in the app', async () => {
    const requestRow = await sendAndCompile(await createPaper());
    reachDate(requestRow);
    await secretariat.sweep();
    expect(requestRow.status).toBe('READY');
    const notices = t.db.rows('notification', { type: 'PRINT_READY' });
    expect(notices.map((notice) => notice.userId)).toEqual([secretary.id]);
    await secretariat.sweep();
    expect(t.db.rows('notification', { type: 'PRINT_READY' })).toHaveLength(1);
  });
});

describe('former teachers', () => {
  it('lose the preview of their sends once they leave or lose the teacher profile', async () => {
    const id = await createPaper();
    const requestRow = await sendAndCompile(id);
    reachDate(requestRow);
    await as(teacher).post(`/print-requests/${requestRow.id}/preview`).expect(200);
    // Profile changed to student: no more preview, nor changes of the former send.
    await as(owner)
      .patch(`/organizations/${org.id}/members/${teacher.id}`, { kind: 'STUDENT' })
      .expect(200);
    await as(teacher).post(`/print-requests/${requestRow.id}/preview`).expect(404);
    const detail = await as(teacher).get(`/exam-papers/${id}`).expect(200);
    expect(detail.body.requests[0].can).toMatchObject({ preview: false, cancel: false });
    // Back as a teacher, then gone from the organization: the same.
    await as(owner)
      .patch(`/organizations/${org.id}/members/${teacher.id}`, { kind: 'TEACHER' })
      .expect(200);
    await as(teacher).post(`/print-requests/${requestRow.id}/preview`).expect(200);
    await as(teacher).post(`/organizations/${org.id}/leave`).expect(204);
    await as(teacher).post(`/print-requests/${requestRow.id}/preview`).expect(404);
    // The secretariat still serves it.
    await as(secretary).post(`/print-requests/${requestRow.id}/preview`).expect(200);
  });
});

describe('co-editors', () => {
  it('are confirmed teachers of the organization, journaled, removed when they leave', async () => {
    const id = await createPaper();
    await as(teacher)
      .post(`/exam-papers/${id}/coeditors`, { userId: student.id })
      .expect(409, { code: 'coeditor_invalid' });
    await as(teacher).post(`/exam-papers/${id}/coeditors`, { userId: teacher2.id }).expect(200);
    expect(t.db.rows('projectMember', { projectId: id })).toMatchObject([
      { userId: teacher2.id, role: 'EDITOR' },
    ]);
    // A co-editor writes but neither sends, downloads, nor manages co-editors.
    await as(teacher2).get(`/exam-papers/${id}`).expect(200);
    await as(teacher2)
      .post(`/exam-papers/${id}/send`, sendBody(l3.id as string))
      .expect(403);
    await as(teacher2).post(`/projects/${id}/archive`).expect(403);
    await as(teacher2).post(`/exam-papers/${id}/coeditors`, { userId: admin.id }).expect(403);
    expect(t.db.rows('printEvent', { projectId: id }).map((e) => e.type)).toEqual([
      'COEDITOR_ADDED',
    ]);
    // Leaving the organization ends the co-edition.
    await as(teacher2).post(`/organizations/${org.id}/leave`).expect(204);
    expect(t.db.rows('projectMember', { projectId: id })).toEqual([]);
    expect(t.db.rows('printEvent', { projectId: id }).map((e) => e.type)).toEqual([
      'COEDITOR_ADDED',
      'COEDITOR_REMOVED',
    ]);
    expect(t.db.rows('auditLog', { action: 'PROJECT_ACCESS_REMOVED', targetId: id })).toHaveLength(
      1,
    );
  });
});

describe('secretariat members', () => {
  it('serve at least one group; a group they serve is never deleted', async () => {
    const someone = person('Nouveau');
    member(someone, 'STUDENT');
    await as(owner)
      .patch(`/organizations/${org.id}/members/${someone.id}`, { kind: 'SECRETARY' })
      .expect(400, { code: 'secretary_groups_required' });
    await as(owner)
      .patch(`/organizations/${org.id}/members/${someone.id}`, {
        kind: 'SECRETARY',
        scopeGroupIds: [l3.id],
      })
      .expect(200);
    const page = await as(owner).get(`/organizations/${org.id}/members`).expect(200);
    const row = page.body.members.find((m: Row) => m.userId === someone.id);
    expect(row).toMatchObject({ kind: 'SECRETARY', scopeGroupIds: [l3.id] });
    await as(owner).delete(`/organizations/${org.id}/groups/${l3.id}`).expect(409);
    // Nobody gives themself the secretariat profile, the owner included.
    await as(owner)
      .patch(`/organizations/${org.id}/members/${owner.id}`, {
        kind: 'SECRETARY',
        scopeGroupIds: [ufr.id],
      })
      .expect(403);
    await as(student)
      .patch(`/organizations/${org.id}/members/${student.id}`, {
        kind: 'SECRETARY',
        scopeGroupIds: [ufr.id],
      })
      .expect(403);
    // Never with the admin role, both ways.
    await as(owner)
      .patch(`/organizations/${org.id}/members/${someone.id}`, { admin: true })
      .expect(409, { code: 'secretary_admin' });
    await as(owner)
      .patch(`/organizations/${org.id}/members/${admin.id}`, {
        kind: 'SECRETARY',
        scopeGroupIds: [l3.id],
      })
      .expect(409, { code: 'secretary_admin' });
    expect(t.db.rows('membership', { userId: admin.id })[0]).toMatchObject({
      role: 'ADMIN',
      kind: 'TEACHER',
    });
    // Back to student: the groups go.
    await as(owner)
      .patch(`/organizations/${org.id}/members/${someone.id}`, { kind: 'STUDENT' })
      .expect(200);
    expect(t.db.rows('secretariatScope', { groupId: l3.id })).toEqual([]);
  });
});

describe('official templates', () => {
  it('are added by managers and offered to the members once published', async () => {
    const archive = zipSync({ 'main.tex': new TextEncoder().encode('\\documentclass{article}') });
    await as(teacher).zip(`/organizations/${org.id}/templates?name=Mémoire`, archive).expect(403);
    const added = await as(admin)
      .zip(`/organizations/${org.id}/templates?name=Mémoire`, archive)
      .expect(201);
    expect(added.body).toMatchObject([{ name: 'Mémoire', published: false }]);
    const templateId = added.body[0].id as string;
    expect(t.storage.objects.has(`${TEMPLATES_BUCKET}/org/${org.id}/${templateId}.zip`)).toBe(true);
    const templates = t.app.get(TemplatesService);
    expect(await templates.list(student.id as string)).toEqual([]);
    await as(admin)
      .patch(`/organizations/${org.id}/templates/${templateId}`, { published: true })
      .expect(200);
    expect((await templates.list(student.id as string)).map((tpl) => tpl.id)).toEqual([templateId]);
    // Never offered outside the organization.
    expect(await templates.list(person('Ailleurs').id as string)).toEqual([]);
    expect(t.db.rows('auditLog', { action: 'ORG_TEMPLATE_PUBLISHED' })).toHaveLength(1);
    await as(admin).delete(`/organizations/${org.id}/templates/${templateId}`).expect(200);
    expect(t.db.tables.template).toEqual([]);
  });
});
