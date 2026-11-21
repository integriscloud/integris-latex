import { SEAT_REASSIGN_DAYS } from '@integris/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QuotaService } from '../projects/quota.service.js';
import { type BillingTestApp, createBillingTestApp } from '../test/billing-app.js';
import { TEST_USER_HEADER } from '../test/projects-app.js';
import { OrganizationsModule } from './organizations.module.js';
import { SupervisionService } from './supervision.service.js';

const ORIGIN = 'http://127.0.0.1:3000';
const DAY_MS = 86_400_000;
const GB = 1024 ** 3;

type Row = Record<string, unknown>;

let t: BillingTestApp;
let owner: Row;
let orgId: string;
let phoneSeq = 0;

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
    csv: (path: string, text: string) =>
      server()
        .post(`/api${path}`)
        .set(TEST_USER_HEADER, id)
        .set('Origin', ORIGIN)
        .set('content-type', 'application/octet-stream')
        .send(text),
  };
};

/** Local number (typed as in the form) and its E.164 form. */
function nextPhone() {
  phoneSeq++;
  const local = `70${String(phoneSeq).padStart(6, '0')}`;
  return { local, e164: `+226${local}` };
}

/** An account with a verified phone number (and e-mail). */
function person(name = 'Membre') {
  const phone = nextPhone();
  return t.db.addUser({
    displayName: `${name} ${phoneSeq}`,
    phone: phone.e164,
    phoneVerifiedAt: new Date(),
    email: `u${phoneSeq}@integris.test`,
    emailVerifiedAt: new Date(),
  });
}

/** Pays a TEAM or BUSINESS through checkout and the LigdiCash callback. */
async function buyOrganization(plan: 'TEAM' | 'BUSINESS', seats: number, who: Row) {
  const order = {
    kind: 'NEW',
    plan,
    period: 'MONTHLY',
    seats,
    organization: { name: 'Univ Test' },
  };
  const response = await as(who).post('/billing/checkout', { order, locale: 'fr' }).expect(201);
  t.provider.pay(`tok_${t.provider.invoices.length}`);
  await request(t.app.getHttpServer())
    .post('/api/payments/ligdicash/callback')
    .send({
      status: 'completed',
      custom_data: [
        { keyof_customdata: 'transaction_id', valueof_customdata: response.body.paymentId },
      ],
    })
    .expect(200);
  return t.db.rows('membership', { userId: who.id, role: 'OWNER' }).at(-1)!
    .organizationId as string;
}

/** Invites by phone, returns the token of the SMS link. */
async function invite(who: Row, invitee: Row, extra: object = {}, org = orgId) {
  const local = (invitee.phone as string).slice(4);
  await as(who)
    .post(`/organizations/${org}/invitations`, {
      channel: 'phone',
      phone: local,
      dialCode: '226',
      ...extra,
    })
    .expect(201);
  const sms = t.outbox.sms.at(-1)!;
  expect(sms.to).toBe(invitee.phone);
  return /#token=([A-Za-z0-9_-]{43})/.exec(sms.text)![1]!;
}

async function join(member: Row, extra: object = {}, by = owner, org = orgId) {
  const token = await invite(by, member, extra, org);
  await as(member).post('/org-invitations/accept', { token }).expect(200);
}

const seats = async (who = owner) =>
  (await as(who).get(`/organizations/${orgId}/members`).expect(200)).body.seats;

const audit = (action: string) => t.db.rows('auditLog', { action });

beforeAll(async () => {
  t = await createBillingTestApp({}, [OrganizationsModule]);
});

afterAll(async () => {
  await t.app.close();
});

beforeEach(async () => {
  t.db.reset();
  t.db.addPlans();
  const quota = {
    maxCompileSeconds: 20,
    maxCompilesPerHour: 30,
    autoCompile: false,
    historyDays: 1,
    aiRequestsPerDay: 0,
    compilePriority: 'LOW',
    maxAdmins: 0,
    supervisionDashboard: false,
    maxSupervisedStudents: null,
    maxProjects: 3,
    maxCollaboratorsPerProject: 1,
    storageBytes: BigInt(100 * 1024 * 1024),
  };
  for (const plan of t.db.tables.plan) Object.assign(plan, quota);
  Object.assign(t.db.rows('plan', { code: 'TEAM' })[0]!, {
    maxProjects: null,
    storageBytes: BigInt(5 * GB),
  });
  Object.assign(t.db.rows('plan', { code: 'BUSINESS' })[0]!, {
    maxProjects: null,
    storageBytes: BigInt(5 * GB),
    maxAdmins: 5,
    supervisionDashboard: true,
    maxSupervisedStudents: 30,
  });
  t.provider.invoices = [];
  t.provider.statuses.clear();
  t.outbox.mails = [];
  t.outbox.sms = [];
  t.reconciled.length = 0;
  owner = person('Titulaire');
  orgId = await buyOrganization('BUSINESS', 10, owner);
});

describe('seats', () => {
  it('gives the owner a seat and reserves one per pending invitation', async () => {
    expect(await seats()).toMatchObject({ total: 10, held: 1, reserved: 0, free: 9 });
    const student = person('Étudiant');
    await invite(owner, student);
    expect(await seats()).toMatchObject({ held: 1, reserved: 1, free: 8 });
    expect(audit('SEAT_RESERVED')).toHaveLength(1);
    expect(t.outbox.sms.at(-1)!.text).toContain('/fr/join#token=');
  });

  it('gives a declined, revoked or expired invitation its seat back at once', async () => {
    const [a, b, c] = [person(), person(), person()];
    const tokenA = await invite(owner, a);
    await invite(owner, b);
    await invite(owner, c);
    expect((await seats()).free).toBe(6);
    await as(a).post('/org-invitations/decline', { token: tokenA }).expect(204);
    const pending = (await as(owner).get(`/organizations/${orgId}/members`)).body.invitations;
    await as(owner)
      .delete(
        `/organizations/${orgId}/invitations/${pending.find((i: Row) => i.contact === b.phone).id}`,
      )
      .expect(200);
    t.db.rows('invitation', { phone: c.phone })[0]!.expiresAt = new Date(Date.now() - 1000);
    expect(await seats()).toMatchObject({ held: 1, reserved: 0, waiting: 0, free: 9 });
    expect(
      audit('SEAT_UNRESERVED')
        .map((row) => (row.metadata as Row).reason)
        .sort(),
    ).toEqual(['declined', 'expired', 'revoked']);
  });

  it('refuses an invitation when no seat is free, the owner included in the count', async () => {
    for (let i = 0; i < 9; i++) await invite(owner, person());
    const response = await as(owner)
      .post(`/organizations/${orgId}/invitations`, {
        channel: 'email',
        email: 'late@integris.test',
      })
      .expect(402);
    expect(response.body.code).toBe('no_free_seat');
  });

  it('accepts with the invited account only and gives it the reserved seat', async () => {
    const student = person();
    const token = await invite(owner, student, { kind: 'STUDENT' });
    const other = person();
    expect((await as(other).post('/org-invitations/accept', { token })).body.code).toBe(
      'invitation_other_account',
    );
    const view = await request(t.app.getHttpServer())
      .post('/api/org-invitations/view')
      .set('Origin', ORIGIN)
      .send({ token })
      .expect(200);
    expect(view.body).toMatchObject({ organizationName: 'Univ Test', kind: 'STUDENT' });
    await as(student).post('/org-invitations/accept', { token }).expect(200);
    expect(await seats()).toMatchObject({ held: 2, reserved: 0, free: 8 });
    expect(t.db.rows('membership', { userId: student.id })[0]).toMatchObject({
      status: 'ACTIVE',
      kind: 'STUDENT',
      role: 'MEMBER',
    });
    expect(audit('SEAT_ASSIGNED').at(-1)!.metadata).toMatchObject({ userId: student.id });
    expect(t.reconciled).toContain(student.id);
    // The space appears at once.
    const spaces = t.db.rows('membership', { userId: student.id, status: 'ACTIVE' });
    expect(spaces).toHaveLength(1);
    await as(student).post('/org-invitations/accept', { token }).expect(410);
  });

  it('makes a released seat reassignable only after 30 days', async () => {
    const members = Array.from({ length: 9 }, () => person());
    for (const member of members) await join(member);
    expect(await seats()).toMatchObject({ held: 10, free: 0 });
    await as(owner).delete(`/organizations/${orgId}/members/${members[0]!.id}`).expect(200);
    const summary = await seats();
    expect(summary).toMatchObject({ held: 9, waiting: 1, free: 0 });
    expect(Date.parse(summary.nextFreeAt) - Date.now()).toBeGreaterThan(
      (SEAT_REASSIGN_DAYS - 1) * DAY_MS,
    );
    const late = person();
    expect(
      (
        await as(owner).post(`/organizations/${orgId}/invitations`, {
          channel: 'phone',
          phone: (late.phone as string).slice(4),
          dialCode: '226',
        })
      ).body.code,
    ).toBe('no_free_seat');
    const released = t.db.rows('seat', { userId: members[0]!.id })[0]!;
    released.reassignableAt = new Date(Date.now() - 1000);
    await join(late);
    expect(t.db.rows('seat', { id: released.id })[0]).toMatchObject({
      userId: late.id,
      releasedAt: null,
    });
  });

  it('keeps quotas per seat: the best plan wins, never pooled', async () => {
    const member = person();
    await join(member);
    const quotas = await t.app.get(QuotaService).quotas(member.id as string);
    expect(quotas.planCode).toBe('BUSINESS');
    expect(quotas.maxProjects).toBeNull();
    // 5 GB for this seat, not 10 seats × 5 GB.
    expect(quotas.storageBytes).toBe(BigInt(5 * GB));
    await as(owner).delete(`/organizations/${orgId}/members/${member.id}`).expect(200);
    expect((await t.app.get(QuotaService).quotas(member.id as string)).planCode).toBe('FREE');
  });

  it('pauses a paid STANDARD while the seat is held and resumes it after', async () => {
    const member = person();
    const end = new Date(Date.now() + 20 * DAY_MS);
    t.db.insert('subscription', {
      planId: 'STANDARD',
      userId: member.id,
      status: 'ACTIVE',
      billingPeriod: 'MONTHLY',
      currentPeriodStart: new Date(Date.now() - 10 * DAY_MS),
      currentPeriodEnd: end,
    });
    await join(member);
    expect(t.db.rows('subscription', { userId: member.id })[0]).toMatchObject({
      status: 'PAUSED',
      pausedRemainingDays: 20,
    });
    await as(member).post(`/organizations/${orgId}/leave`).expect(204);
    expect(t.db.rows('subscription', { userId: member.id })[0]!.status).toBe('ACTIVE');
    expect(audit('ORG_MEMBER_LEFT')).toHaveLength(1);
    expect(audit('SEAT_RELEASED')).toHaveLength(1);
  });
});

describe('seats and payments (security review)', () => {
  it('never gives more seats than paid, nor beyond a lower renewal already paid', async () => {
    const subscription = t.db.rows('subscription', { organizationId: orgId })[0]!;
    // A stray seat row beyond the 10 paid does not make an eleventh seat usable.
    t.db.insert('seat', { subscriptionId: subscription.id });
    for (let i = 0; i < 9; i++) await invite(owner, person());
    expect(
      (
        await as(owner).post(`/organizations/${orgId}/invitations`, {
          channel: 'email',
          email: 'eleventh@integris.test',
        })
      ).body.code,
    ).toBe('no_free_seat');
    await as(owner)
      .delete(`/organizations/${orgId}/invitations/${t.db.rows('invitation')[0]!.id}`)
      .expect(200);
    // Rows are copied back after a refused transaction: read the subscription again.
    t.db.rows('subscription', { organizationId: orgId })[0]!.pendingSeatCount = 9;
    expect(
      (
        await as(owner).post(`/organizations/${orgId}/invitations`, {
          channel: 'email',
          email: 'ninth@integris.test',
        })
      ).body.code,
    ).toBe('no_free_seat');
  });

  it('counts released seats when seats are removed, and keeps reserved ones', async () => {
    const { resizeSeats } = await import('../billing/seat-resize.js');
    const subscription = t.db.rows('subscription', { organizationId: orgId })[0]!;
    const [a, b] = [person(), person()];
    await join(a);
    await join(b);
    await as(owner).delete(`/organizations/${orgId}/members/${a.id}`).expect(200);
    await invite(owner, person());
    // 10 rows: owner and b held, 1 released, 1 reserved, 6 never used.
    const { removed } = await resizeSeats(t.db.client as never, subscription.id as string, 3);
    expect(removed).toHaveLength(7);
    const left = t.db.rows('seat', { subscriptionId: subscription.id });
    expect(left).toHaveLength(3);
    expect(left.filter((seat) => seat.invitationId)).toHaveLength(1);
    expect(left.filter((seat) => seat.userId && !seat.releasedAt)).toHaveLength(2);
  });

  it('keeps part of the SMS budget for sign-in codes and caps each organization', async () => {
    const redis = t.app.get((await import('../redis/redis.service.js')).RedisService).client;
    const key = `rl:sms:day:${new Date().toISOString().slice(0, 10)}`;
    const before = await redis.get(key);
    await redis.set(key, String(Math.floor(1_000_000)));
    const refused = await as(owner).post(`/organizations/${orgId}/invitations`, {
      channel: 'phone',
      phone: '70999999',
      dialCode: '226',
    });
    expect(refused.body.code).toBe('sms_unavailable');
    // The refused invitation gave its seat back.
    expect((await seats()).reserved).toBe(0);
    if (before === null) await redis.del(key);
    else await redis.set(key, before);
  });

  it('gives no seat once the subscription lapsed', async () => {
    const student = person();
    const token = await invite(owner, student);
    const subscription = t.db.rows('subscription', { organizationId: orgId })[0]!;
    subscription.status = 'EXPIRED';
    const response = await as(student).post('/org-invitations/accept', { token }).expect(409);
    expect(response.body.code).toBe('subscription_inactive');
  });
});

describe('roles', () => {
  it('lets only the owner name admins, 5 at most', async () => {
    const members = Array.from({ length: 6 }, () => person());
    for (const member of members) await join(member);
    for (const member of members.slice(0, 5)) {
      await as(owner)
        .patch(`/organizations/${orgId}/members/${member.id}`, { admin: true })
        .expect(200);
    }
    const sixth = await as(owner)
      .patch(`/organizations/${orgId}/members/${members[5]!.id}`, { admin: true })
      .expect(409);
    expect(sixth.body.code).toBe('admin_limit');
    const admin = members[0]!;
    expect(
      (await as(admin).patch(`/organizations/${orgId}/members/${members[5]!.id}`, { admin: true }))
        .body.code,
    ).toBe('org_forbidden');
    expect(audit('ORG_ROLE_CHANGED')).toHaveLength(5);
  });

  it('lets admins invite and remove members, but not the owner nor another admin', async () => {
    const [admin, other, member] = [person(), person(), person()];
    for (const who of [admin, other]) {
      await join(who);
      await as(owner)
        .patch(`/organizations/${orgId}/members/${who.id}`, { admin: true })
        .expect(200);
    }
    await join(member, {}, admin);
    expect((await as(admin).delete(`/organizations/${orgId}/members/${owner.id}`)).body.code).toBe(
      'cannot_remove_owner',
    );
    expect((await as(admin).delete(`/organizations/${orgId}/members/${other.id}`)).body.code).toBe(
      'org_forbidden',
    );
    await as(admin).delete(`/organizations/${orgId}/members/${member.id}`).expect(200);
    expect((await as(owner).post(`/organizations/${orgId}/leave`)).body.code).toBe(
      'owner_cannot_leave',
    );
  });

  it('keeps members away from management, and a TEAM has no admins', async () => {
    const member = person();
    await join(member);
    expect((await as(member).get(`/organizations/${orgId}/members`)).body.code).toBe(
      'org_forbidden',
    );
    const view = (await as(member).get(`/organizations/${orgId}`).expect(200)).body;
    expect(view).toMatchObject({ seats: null, joinCode: null, me: { manages: false } });
    const outsider = person();
    expect((await as(outsider).get(`/organizations/${orgId}`)).status).toBe(404);

    const teamOwner = person();
    const teamId = await buyOrganization('TEAM', 3, teamOwner);
    const teammate = person();
    await join(teammate, {}, teamOwner, teamId);
    expect(t.db.rows('membership', { userId: teammate.id })[0]!.kind).toBe('OTHER');
    const refused = await as(teamOwner).patch(`/organizations/${teamId}/members/${teammate.id}`, {
      admin: true,
    });
    expect(refused.body.code).toBe('business_only');
  });

  it('shows the consumption of members, never their projects', async () => {
    const member = person();
    await join(member);
    const project = t.db.insert('project', {
      ownerId: member.id,
      name: 'Mémoire secret',
      engine: 'PDFLATEX',
      mainFilePath: 'main.tex',
    });
    t.db.insert('projectFile', { projectId: project.id, path: 'main.tex', sizeBytes: 1234 });
    const response = await as(owner).get(`/organizations/${orgId}/members`).expect(200);
    const row = response.body.members.find((m: Row) => m.userId === member.id);
    expect(row.usage).toEqual({ projects: 1, storageBytes: 1234, compiles: 0, compileSeconds: 0 });
    expect(JSON.stringify(response.body)).not.toContain('Mémoire secret');
    expect(row.contactHint).toMatch(/^\+226 •• •• •• \d\d$/);
  });
});

describe('member rights (step 12 decision)', () => {
  const patch = (who: Row, target: Row, body: object) =>
    as(who).patch(`/organizations/${orgId}/members/${target.id}`, body);
  const membership = (who: Row) => t.db.rows('membership', { userId: who.id })[0]!;

  async function admin(kind: 'TEACHER' | 'STUDENT' = 'TEACHER') {
    const who = person('Admin');
    await join(who, { kind });
    await patch(owner, who, { admin: true }).expect(200);
    return who;
  }

  it('lets only the owner change the profile or group of the owner or of an admin', async () => {
    const group = (
      await as(owner).post(`/organizations/${orgId}/groups`, { name: 'L3' }).expect(201)
    ).body[0];
    const [first, second] = [await admin(), await admin()];
    for (const body of [{ kind: 'STUDENT' }, { groupId: group.id }]) {
      expect((await patch(first, second, body)).body.code).toBe('org_forbidden');
      expect((await patch(first, owner, body)).body.code).toBe('org_forbidden');
      // Their own profile and group are not theirs to change either.
      expect((await patch(first, first, body)).body.code).toBe('org_forbidden');
    }
    await patch(owner, second, { kind: 'STUDENT', groupId: group.id }).expect(200);
    expect(membership(second)).toMatchObject({ kind: 'STUDENT', groupId: group.id });
    // An admin still changes the plain members.
    const member = person();
    await join(member, { kind: 'STUDENT' });
    await patch(first, member, { groupId: group.id }).expect(200);
  });

  it('never lets someone raise their own role; the owner may make themself a teacher', async () => {
    const self = await admin('STUDENT');
    expect((await patch(self, self, { kind: 'TEACHER' })).body.code).toBe('org_forbidden');
    expect((await patch(self, self, { admin: false })).body.code).toBe('org_forbidden');
    const member = person();
    await join(member, { kind: 'STUDENT' });
    // A plain member manages nothing, themself included.
    expect((await patch(member, member, { kind: 'TEACHER' })).body.code).toBe('org_forbidden');
    expect((await patch(owner, owner, { admin: true })).body.code).toBe('cannot_remove_owner');
    await patch(owner, owner, { kind: 'TEACHER' }).expect(200);
    expect(membership(owner).kind).toBe('TEACHER');
  });

  it('turns a student into a teacher only through a confirmed join request', async () => {
    const code = (await as(owner).get(`/organizations/${orgId}`)).body.joinCode;
    const [student, teacher] = [person('Étudiant'), person('Enseignant')];
    await join(student, { kind: 'STUDENT' });
    await join(teacher, { kind: 'TEACHER' });
    await as(owner)
      .post(`/organizations/${orgId}/supervisions`, {
        supervisorId: teacher.id,
        studentId: student.id,
      })
      .expect(201);
    const before = await seats();
    const asked = await as(student).post('/organizations/join', { code }).expect(200);
    expect(asked.body.status).toBe('PENDING_APPROVAL');
    expect((await as(student).post('/organizations/join', { code })).body.code).toBe(
      'join_pending',
    );
    expect((await as(teacher).post('/organizations/join', { code })).body.code).toBe(
      'already_org_member',
    );
    // Still a student until an admin confirms; no new seat.
    expect(membership(student)).toMatchObject({ kind: 'STUDENT' });
    const view = (await as(student).get(`/organizations/${orgId}`)).body;
    expect(view.me).toMatchObject({ kind: 'STUDENT', teacherRequested: true });
    const requests = (await as(owner).get(`/organizations/${orgId}/members`)).body.joinRequests;
    expect(requests).toEqual([expect.objectContaining({ userId: student.id, type: 'teacher' })]);

    await as(owner).post(`/organizations/${orgId}/join-requests/${student.id}/reject`).expect(200);
    expect(membership(student)).toMatchObject({ kind: 'STUDENT', teacherRequestedAt: null });

    await as(student).post('/organizations/join', { code }).expect(200);
    await as(owner)
      .post(`/organizations/${orgId}/join-requests/${student.id}/approve`, {})
      .expect(200);
    expect(membership(student)).toMatchObject({ kind: 'TEACHER', teacherRequestedAt: null });
    expect(await seats()).toEqual(before);
    // Their link as a student ended with the change.
    expect(t.db.rows('supervision', { studentId: student.id })[0]!.status).toBe('ENDED');
  });

  it('lets only the owner confirm the request of an admin, never its author', async () => {
    const code = (await as(owner).get(`/organizations/${orgId}`)).body.joinCode;
    const [asking, other] = [await admin('STUDENT'), await admin()];
    await as(asking).post('/organizations/join', { code }).expect(200);
    const approve = (who: Row) =>
      as(who).post(`/organizations/${orgId}/join-requests/${asking.id}/approve`, {});
    expect((await approve(asking)).body.code).toBe('org_forbidden');
    expect((await approve(other)).body.code).toBe('org_forbidden');
    await approve(owner).expect(200);
    expect(membership(asking).kind).toBe('TEACHER');
  });

  it('lets members choose their own group only when an admin allows it', async () => {
    const group = (
      await as(owner).post(`/organizations/${orgId}/groups`, { name: 'M2' }).expect(201)
    ).body[0];
    const member = person();
    await join(member, { kind: 'STUDENT' });
    const choose = (groupId: string | null) =>
      as(member).patch(`/organizations/${orgId}/my-group`, { groupId });
    expect((await choose(group.id)).body.code).toBe('org_forbidden');
    expect((await as(member).get(`/organizations/${orgId}`)).body.groups).toBeNull();
    expect(
      (await as(member).patch(`/organizations/${orgId}/settings`, { membersChooseGroup: true }))
        .body.code,
    ).toBe('org_forbidden');

    const adminUser = await admin();
    await as(adminUser)
      .patch(`/organizations/${orgId}/settings`, { membersChooseGroup: true })
      .expect(200);
    expect(audit('ORG_SETTINGS_CHANGED')).toHaveLength(1);
    const view = (await choose(group.id).expect(200)).body;
    expect(view.me.groupId).toBe(group.id);
    expect(view.groups.map((g: Row) => g.id)).toEqual([group.id]);
    expect((await choose('not-a-group')).body.code).toBe('group_not_found');
    await choose(null).expect(200);
    expect(membership(member).groupId).toBeNull();
    expect(audit('ORG_MEMBER_GROUP_CHANGED').at(-1)!.metadata).toMatchObject({ self: true });

    await as(owner)
      .patch(`/organizations/${orgId}/settings`, { membersChooseGroup: false })
      .expect(200);
    expect((await choose(group.id)).body.code).toBe('org_forbidden');
  });
});

describe('join requests', () => {
  it('keeps a self-declared teacher pending until an admin confirms, then takes a seat', async () => {
    const view = (await as(owner).get(`/organizations/${orgId}`).expect(200)).body;
    expect(view.joinCode).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    const teacher = person('Enseignant');
    expect((await as(teacher).post('/organizations/join', { code: 'ZZZZZ-ZZZZZ' })).body.code).toBe(
      'join_code_invalid',
    );
    const joined = await as(teacher)
      .post('/organizations/join', { code: view.joinCode.toLowerCase() })
      .expect(200);
    expect(joined.body).toEqual({ organizationName: 'Univ Test', status: 'PENDING_APPROVAL' });
    expect((await as(teacher).post('/organizations/join', { code: view.joinCode })).body.code).toBe(
      'join_pending',
    );
    // Pending: no seat, no space, no access.
    expect(await seats()).toMatchObject({ held: 1 });
    expect((await as(teacher).get(`/organizations/${orgId}`)).status).toBe(404);
    expect((await as(owner).get(`/organizations/${orgId}/members`)).body.joinRequests).toHaveLength(
      1,
    );
    expect(
      t.db.rows('notification', { userId: owner.id, type: 'ORG_JOIN_REQUESTED' }),
    ).toHaveLength(1);

    await as(owner)
      .post(`/organizations/${orgId}/join-requests/${teacher.id}/approve`, {})
      .expect(200);
    expect(t.db.rows('membership', { userId: teacher.id })[0]).toMatchObject({
      status: 'ACTIVE',
      kind: 'TEACHER',
      approvedById: owner.id,
    });
    expect(await seats()).toMatchObject({ held: 2 });
    expect(audit('ORG_JOIN_APPROVED')).toHaveLength(1);
  });

  it('refuses the confirmation without a free seat, and a refusal deletes the request', async () => {
    for (let i = 0; i < 9; i++) await invite(owner, person());
    const code = (await as(owner).get(`/organizations/${orgId}`)).body.joinCode;
    const [a, b] = [person(), person()];
    await as(a).post('/organizations/join', { code }).expect(200);
    await as(b).post('/organizations/join', { code }).expect(200);
    expect(
      (await as(owner).post(`/organizations/${orgId}/join-requests/${a.id}/approve`, {})).body.code,
    ).toBe('no_free_seat');
    await as(owner).post(`/organizations/${orgId}/join-requests/${b.id}/reject`).expect(200);
    expect(t.db.rows('membership', { userId: b.id })).toHaveLength(0);
    expect(audit('ORG_JOIN_REJECTED')).toHaveLength(1);
  });
});

describe('CSV import', () => {
  async function runImport(csv: string) {
    const started = await as(owner).csv(`/organizations/${orgId}/imports?name=liste.csv`, csv);
    expect(started.status).toBe(201);
    for (let i = 0; i < 400; i++) {
      const report = await as(owner).get(`/organizations/${orgId}/imports/${started.body.id}`);
      if (report.body.status !== 'PROCESSING') return report.body;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('import not finished');
  }

  it('invites each valid line with a seat and reports the others', async () => {
    await as(owner)
      .post(`/organizations/${orgId}/groups`, { name: 'Master 2 Environnement' })
      .expect(201);
    const member = person();
    await join(member);
    const csv = [
      'Nom;Téléphone;Email;Profil;Classe',
      'Awa;70 11 11 11;;Étudiant;Master 2 Environnement',
      'Issa;;issa@integris.test;enseignant;',
      'Awa bis;70111111;;etudiant;',
      'Mauvais;12;;etudiant;',
      'Inconnu;70 22 22 22;;etudiant;Licence 9',
      'Profil;70 33 33 33;;directeur;',
      'Sans contact;;;etudiant;',
      `Déjà;${(member.phone as string).slice(4)};;etudiant;`,
      '',
    ].join('\r\n');
    const report = await runImport(`${String.fromCharCode(0xfeff)}${csv}`);
    expect(report).toMatchObject({ totalRows: 8, invitedCount: 2, fileName: 'liste.csv' });
    expect(report.errors.map((e: Row) => [e.line, e.reason])).toEqual([
      [4, 'duplicate_row'],
      [5, 'contact_invalid'],
      [6, 'group_unknown'],
      [7, 'kind_invalid'],
      [8, 'contact_missing'],
      [9, 'already_member'],
    ]);
    expect(await seats()).toMatchObject({ held: 2, reserved: 2, free: 6 });
    const awa = t.db.rows('invitation', { phone: '+22670111111' })[0]!;
    expect(awa).toMatchObject({ kind: 'STUDENT', displayName: 'Awa' });
    expect(awa.groupId).not.toBeNull();
    expect(t.db.rows('invitation', { email: 'issa@integris.test' })[0]!.kind).toBe('TEACHER');
    expect(t.outbox.mails.at(-1)!.text).toContain('/fr/join#token=');
  });

  it('reports the lines beyond the free seats', async () => {
    const lines = Array.from(
      { length: 11 },
      (_, i) => `M${i};70 5${String(i).padStart(5, '0')};;;`,
    );
    const report = await runImport(
      ['nom,telephone,email,profil,classe', ...lines.map((l) => l.replace(/;/g, ','))].join('\n'),
    );
    expect(report.status).toBe('DONE');
    expect(report.invitedCount).toBe(9);
    expect(report.errors.map((e: Row) => e.reason)).toEqual(['no_free_seat', 'no_free_seat']);
  });

  it('refuses a file that is not a member CSV, and members cannot import', async () => {
    expect((await as(owner).csv(`/organizations/${orgId}/imports`, 'a;b\n1;2')).body.code).toBe(
      'csv_invalid',
    );
    const member = person();
    await join(member);
    expect(
      (await as(member).csv(`/organizations/${orgId}/imports`, 'email\nx@y.z')).body.code,
    ).toBe('org_forbidden');
  });
});

describe('groups', () => {
  it('creates nested groups, refuses duplicates, cycles and deleting a used group', async () => {
    const ufr = (await as(owner).post(`/organizations/${orgId}/groups`, { name: 'UFR SVT' }))
      .body[0];
    const groups = (
      await as(owner)
        .post(`/organizations/${orgId}/groups`, { name: 'Hydrologie', parentId: ufr.id })
        .expect(201)
    ).body;
    const hydro = groups.find((g: Row) => g.name === 'Hydrologie');
    expect(
      (
        await as(owner).post(`/organizations/${orgId}/groups`, {
          name: 'hydrologie',
          parentId: ufr.id,
        })
      ).body.code,
    ).toBe('group_name_taken');
    expect(
      (
        await as(owner).patch(`/organizations/${orgId}/groups/${ufr.id}`, {
          name: 'UFR SVT',
          parentId: hydro.id,
        })
      ).body.code,
    ).toBe('group_cycle');
    const member = person();
    await join(member, { groupId: hydro.id });
    expect(t.db.rows('membership', { userId: member.id })[0]!.groupId).toBe(hydro.id);
    expect((await as(owner).delete(`/organizations/${orgId}/groups/${ufr.id}`)).body.code).toBe(
      'group_not_empty',
    );
    await as(owner)
      .patch(`/organizations/${orgId}/members/${member.id}`, { groupId: null })
      .expect(200);
    await as(owner).delete(`/organizations/${orgId}/groups/${hydro.id}`).expect(200);
    expect(audit('ORG_MEMBER_GROUP_CHANGED')).toHaveLength(1);
    expect(audit('ORG_GROUP_DELETED')).toHaveLength(1);
  });
});

describe('supervision', () => {
  let teacher: Row;
  let student: Row;
  let project: Row;

  beforeEach(async () => {
    teacher = person('Enseignant');
    student = person('Étudiant');
    await join(teacher, { kind: 'TEACHER' });
    await join(student, { kind: 'STUDENT' });
    project = t.db.insert('project', {
      ownerId: student.id,
      name: 'Mémoire',
      engine: 'PDFLATEX',
      mainFilePath: 'main.tex',
    });
  });

  const assign = (body: object, who = owner) =>
    as(who).post(`/organizations/${orgId}/supervisions`, body);

  it('assigns a supervisor; the student opens a project; the dashboard shows it', async () => {
    const links = (await assign({ supervisorId: teacher.id, studentId: student.id }).expect(201))
      .body.links;
    expect(links).toHaveLength(1);
    const link = links[0];
    expect(t.db.rows('projectMember', { userId: teacher.id })).toHaveLength(0);
    await as(student)
      .post(`/supervisions/${link.id}/projects`, { projectId: project.id })
      .expect(204);
    expect(t.db.rows('projectMember', { userId: teacher.id })[0]).toMatchObject({
      role: 'SUPERVISOR',
      viaSupervisionId: link.id,
    });
    t.db.insert('submission', {
      projectId: project.id,
      authorId: student.id,
      title: 'Chapitre 2',
      status: 'SUBMITTED',
      dueAt: new Date(Date.now() - DAY_MS),
      filePaths: [],
      updatedAt: new Date(),
    });
    const dashboard = (
      await as(teacher).get(`/organizations/${orgId}/supervision-dashboard`).expect(200)
    ).body;
    expect(dashboard).toMatchObject({ students: 1, maxStudents: 30 });
    expect(dashboard.rows[0]).toMatchObject({
      project: { name: 'Mémoire' },
      submission: { title: 'Chapitre 2', status: 'SUBMITTED' },
      urgency: 'overdue',
    });
    expect((await as(student).get(`/organizations/${orgId}/supervision-dashboard`)).body.code).toBe(
      'not_teacher',
    );
  });

  it('sorts the dashboard by urgency: overdue, to review, due soon, then oldest activity', async () => {
    const day = (days: number) => new Date(Date.now() + days * DAY_MS);
    // name, submission (status, due in days) or none, days since the last activity, opened or not
    const cases: [string, [string, number | null] | null, number, boolean][] = [
      ['Calme récent', null, 1, true],
      ['Échéance proche', ['FEEDBACK_SENT', 3], 2, true],
      ['À relire', ['SUBMITTED', null], 1, true],
      ['Calme ancien', null, 20, true],
      ['En retard', ['FEEDBACK_SENT', -1], 1, true],
      ['Validé', ['VALIDATED', -10], 30, true],
      ['Échéance lointaine', ['FEEDBACK_SENT', 30], 3, true],
    ];
    for (const [name, submission, idle] of cases) {
      const who = person(name);
      await join(who, { kind: 'STUDENT' });
      const link = (
        await assign({ supervisorId: teacher.id, studentId: who.id }).expect(201)
      ).body.links.find((row: Row) => (row.student as Row).id === who.id);
      const own = t.db.insert('project', {
        ownerId: who.id,
        name: `Projet ${name}`,
        engine: 'PDFLATEX',
        mainFilePath: 'main.tex',
        lastActivityAt: day(-idle),
      });
      await as(who).post(`/supervisions/${link.id}/projects`, { projectId: own.id }).expect(204);
      if (submission) {
        t.db.insert('submission', {
          projectId: own.id,
          authorId: who.id,
          title: name,
          status: submission[0],
          dueAt: submission[1] === null ? null : day(submission[1]),
          filePaths: [],
          updatedAt: new Date(),
        });
      }
    }
    const rows = (
      await as(teacher).get(`/organizations/${orgId}/supervision-dashboard`).expect(200)
    ).body.rows as Row[];
    expect(rows.map((row) => [(row.student as Row).name, row.urgency])).toEqual([
      [expect.stringMatching(/^En retard/), 'overdue'],
      [expect.stringMatching(/^À relire/), 'to_review'],
      [expect.stringMatching(/^Échéance proche/), 'due_soon'],
      // Nothing pressing: a deadline far away first, then the oldest activity first (a
      // validated submission's deadline no longer counts; drafts are not shown).
      [expect.stringMatching(/^Échéance lointaine/), 'none'],
      [expect.stringMatching(/^Validé/), 'none'],
      [expect.stringMatching(/^Calme ancien/), 'none'],
      [expect.stringMatching(/^Calme récent/), 'none'],
    ]);
  });

  it('ends the link: the supervisor loses the access, the comments stay', async () => {
    const link = (await assign({ supervisorId: teacher.id, studentId: student.id })).body.links[0];
    await as(student)
      .post(`/supervisions/${link.id}/projects`, { projectId: project.id })
      .expect(204);
    await as(owner).post(`/organizations/${orgId}/supervisions/${link.id}/end`).expect(200);
    expect(t.db.rows('projectMember', { userId: teacher.id })).toHaveLength(0);
    expect(t.db.rows('supervision', { id: link.id })[0]!.status).toBe('ENDED');
    expect(audit('SUPERVISION_ENDED')[0]!.metadata).toMatchObject({
      reason: 'ended_by_admin',
      projects: [project.id],
    });
  });

  it('reassigns, and ends links at their end date and when a member leaves', async () => {
    const other = person('Enseignant');
    await join(other, { kind: 'TEACHER' });
    const endsAt = new Date(Date.now() + 5 * DAY_MS).toISOString();
    const link = (await assign({ supervisorId: teacher.id, studentId: student.id, endsAt })).body
      .links[0];
    await as(student)
      .post(`/supervisions/${link.id}/projects`, { projectId: project.id })
      .expect(204);
    const after = (
      await as(owner)
        .post(`/organizations/${orgId}/supervisions/${link.id}/reassign`, {
          supervisorId: other.id,
        })
        .expect(200)
    ).body.links;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ supervisor: { id: other.id }, endsAt });
    expect(t.db.rows('projectMember', { projectId: project.id })).toHaveLength(0);

    await t.app.get(SupervisionService).sweep(new Date(Date.now() + 6 * DAY_MS));
    expect(t.db.rows('supervision', { id: after[0].id })[0]!.status).toBe('ENDED');

    const again = (await assign({ supervisorId: teacher.id, studentId: student.id })).body.links[0];
    await as(owner).delete(`/organizations/${orgId}/members/${teacher.id}`).expect(200);
    expect(t.db.rows('supervision', { id: again.id })[0]!.status).toBe('ENDED');
    expect(
      (
        await assign({
          supervisorId: other.id,
          studentId: student.id,
          endsAt: '2020-01-01T00:00:00.000Z',
        })
      ).body.code,
    ).toBe('end_date_past');
  });

  it('lets the student ask a teacher, who accepts; 30 students at most per supervisor', async () => {
    const mine = (await as(student).get(`/organizations/${orgId}/my-supervisors`).expect(200)).body;
    expect(mine.teachers.map((teacher: Row) => teacher.id)).toEqual([teacher.id]);
    expect(mine.projects).toEqual([{ id: project.id, name: 'Mémoire' }]);
    const requested = (
      await as(student)
        .post(`/organizations/${orgId}/supervision-requests`, { supervisorId: teacher.id })
        .expect(201)
    ).body.links[0];
    expect(requested.status).toBe('PENDING');
    // Pending: no project can be opened yet.
    expect(
      (await as(student).post(`/supervisions/${requested.id}/projects`, { projectId: project.id }))
        .status,
    ).toBe(404);
    const dashboard = (await as(teacher).get(`/organizations/${orgId}/supervision-dashboard`)).body;
    expect(dashboard.requests).toHaveLength(1);
    await as(teacher).post(`/supervisions/${requested.id}/accept`).expect(204);
    expect(t.db.rows('supervision', { id: requested.id })[0]!.status).toBe('ACTIVE');

    t.db.rows('plan', { code: 'BUSINESS' })[0]!.maxSupervisedStudents = 1;
    const second = person('Étudiant');
    await join(second, { kind: 'STUDENT' });
    const refused = await assign({ supervisorId: teacher.id, studentId: second.id }).expect(409);
    expect(refused.body.code).toBe('supervision_limit');
    expect((await assign({ supervisorId: student.id, studentId: second.id })).body.code).toBe(
      'not_teacher',
    );
  });

  it('is managed by admins only', async () => {
    expect(
      (await assign({ supervisorId: teacher.id, studentId: student.id }, teacher)).body.code,
    ).toBe('org_forbidden');
  });
});
