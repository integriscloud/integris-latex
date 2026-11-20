import type { Plan, User } from '@integris/db';
import {
  type AccountUsage,
  COMPILE_PRIORITY_RANK,
  type Compilation,
  READ_ONLY_REASONS,
} from '@integris/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HistoryModule } from '../history/history.module.js';
import { PlanLimitsService } from '../projects/plan-limits.service.js';
import { compileHourKey } from '../projects/quota.service.js';
import { UsageAlertsService } from '../projects/usage-alerts.service.js';
import { RedisService } from '../redis/redis.service.js';
import { SharingModule } from '../sharing/sharing.module.js';
import { ORIGIN } from '../test/auth-app.js';
import { type CompileTestApp, createCompileTestApp } from '../test/compile-app.js';
import { TEST_USER_HEADER } from '../test/projects-app.js';

// The grid of docs/spec.md ("Plans, comptes et membres"), copied here as the `Plan` table the
// API reads: every quota below must come from these rows, for every plan.
const MIB = 1024n * 1024n;
const GIB = 1024n * MIB;
const DAY_MS = 86_400_000;

type Code = Plan['code'];
const GRID: Record<Code, Partial<Plan>> = {
  FREE: {
    maxProjects: 3,
    maxCollaboratorsPerProject: 1,
    maxCompileSeconds: 20,
    maxCompilesPerHour: 30,
    storageBytes: 100n * MIB,
    historyDays: 1,
    autoCompile: false,
    supervisionDashboard: false,
    maxSupervisedStudents: null,
    compilePriority: 'LOW',
  },
  STANDARD: {
    maxProjects: null,
    maxCollaboratorsPerProject: 5,
    maxCompileSeconds: 120,
    maxCompilesPerHour: 120,
    storageBytes: 2n * GIB,
    historyDays: 90,
    autoCompile: true,
    supervisionDashboard: false,
    maxSupervisedStudents: null,
    compilePriority: 'NORMAL',
  },
  TEAM: {
    maxProjects: null,
    maxCollaboratorsPerProject: null,
    maxCompileSeconds: 240,
    maxCompilesPerHour: 200,
    storageBytes: 5n * GIB,
    historyDays: null,
    autoCompile: true,
    supervisionDashboard: false,
    maxSupervisedStudents: null,
    compilePriority: 'HIGH',
  },
  BUSINESS: {
    maxProjects: null,
    maxCollaboratorsPerProject: null,
    maxCompileSeconds: 240,
    maxCompilesPerHour: 200,
    storageBytes: 5n * GIB,
    historyDays: null,
    autoCompile: true,
    supervisionDashboard: true,
    maxSupervisedStudents: 30,
    compilePriority: 'HIGH',
  },
};
const CODES = Object.keys(GRID) as Code[];

const planRow = (code: Code): Plan =>
  ({
    id: code,
    code,
    nameFr: code,
    nameEn: code,
    priceMonthlyXof: 0,
    priceYearlyXof: 0,
    minSeats: 1,
    maxSeats: null,
    volumeDiscountFromSeats: null,
    volumeDiscountPercent: null,
    aiRequestsPerDay: 0,
    maxAdmins: 0,
    trialDays: null,
    isActive: true,
    updatedAt: new Date(),
    ...GRID[code],
  }) as Plan;

describe('plan grid: every quota of every plan, from the Plan table', () => {
  let ctx: CompileTestApp;
  let redis: RedisService;
  let owner: User;
  let projectId: string;

  const as = (user: User) => {
    const server = () => request(ctx.app.getHttpServer());
    const write = (req: request.Test) => req.set('Origin', ORIGIN).set(TEST_USER_HEADER, user.id);
    return {
      get: (path: string) => server().get(`/api/${path}`).set(TEST_USER_HEADER, user.id),
      post: (path: string, body: object = {}) => write(server().post(`/api/${path}`)).send(body),
      patch: (path: string, body: object = {}) => write(server().patch(`/api/${path}`)).send(body),
      upload: (path: string, bytes: number, project = projectId) =>
        write(
          server().put(
            `/api/projects/${project}/files/upload?path=${encodeURIComponent(path)}&replace=true`,
          ),
        )
          .set('Content-Type', 'application/octet-stream')
          .send(Buffer.from('a'.repeat(bytes))),
    };
  };

  /** The user holds the plan as the spec says: FREE alone, a personal STANDARD, or a seat. */
  const hold = (user: User, code: Code) => {
    if (code === 'STANDARD') ctx.db.personalPlans.set(user.id, code);
    if (code === 'TEAM' || code === 'BUSINESS') {
      ctx.db.seatPlans.set(user.id, [{ code, organizationName: 'Université Joseph Ki-Zerbo' }]);
    }
  };

  const newProject = (user: User, name: string) => as(user).post('projects', { name });
  const usage = async (user: User = owner) =>
    (await as(user).get('usage').expect(200)).body as AccountUsage;
  const compile = (body: object = {}) => as(owner).post(`projects/${projectId}/compile`, body);

  /** Fills the owner's storage up to `left` bytes below the limit (a file of the project). */
  const fillStorage = async (code: Code, left: bigint) => {
    const used = ctx.db.files
      .filter((file) => file.projectId === projectId)
      .reduce((sum, file) => sum + file.sizeBytes, 0);
    await ctx.db.client.projectFile.create({
      data: {
        projectId,
        path: 'data/big.bin',
        kind: 'BINARY',
        storageKey: `${projectId}/big`,
        sizeBytes: Number(GRID[code].storageBytes! - left) - used,
      },
    });
  };

  beforeAll(async () => {
    ctx = await createCompileTestApp({ SHARE_INVITATIONS_PER_DAY: '500' }, [
      HistoryModule,
      SharingModule,
    ]);
    redis = ctx.app.get(RedisService);
  });

  beforeEach(async () => {
    ctx.db.reset();
    ctx.db.plans = CODES.map(planRow);
    ctx.queue.reset();
    ctx.storage.objects.clear();
    await redis.client.flushdb();
    owner = ctx.db.addUser('Awa Kaboré');
    owner.email = 'awa@example.org';
    projectId = (await newProject(owner, 'Mémoire').expect(201)).body.id;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  describe.each(CODES)('%s', (code) => {
    const grid = GRID[code];

    beforeEach(() => hold(owner, code));

    it(`projects: ${grid.maxProjects ?? 'unlimited'}`, async () => {
      const max = grid.maxProjects ?? 5;
      for (let index = 1; index < max; index++) {
        await newProject(owner, `Projet ${index}`).expect(201);
      }
      if (grid.maxProjects === null) {
        await newProject(owner, 'One more').expect(201);
        expect((await usage()).projects).toMatchObject({ max: null, level: 'ok' });
        return;
      }
      await newProject(owner, 'One too many').expect(402, { code: 'project_limit' });
      expect((await usage()).projects).toMatchObject({ used: max, max, level: 'full' });
      // The trash frees a place; restoring checks the limit again.
      const last = ctx.db.projects.at(-1)!.id;
      await as(owner).post(`projects/${last}/trash`).expect(204);
      await newProject(owner, 'Instead').expect(201);
      await as(owner).post(`projects/${last}/restore`).expect(402, { code: 'project_limit' });
    });

    it(`collaborators per project: ${grid.maxCollaboratorsPerProject ?? 'unlimited'}`, async () => {
      const max = grid.maxCollaboratorsPerProject ?? 12;
      // Members and pending invitations count; supervisors do not.
      for (let index = 1; index < max; index++) {
        ctx.db.share(projectId, ctx.db.addUser(`Membre ${index}`).id, 'REVIEWER');
      }
      ctx.db.share(projectId, ctx.db.addUser('Encadrant').id, 'SUPERVISOR');
      const invite = (email: string, role = 'EDITOR') =>
        as(owner).post(`projects/${projectId}/invitations`, { channel: 'email', email, role });
      await invite('last@example.org').expect(201);
      if (grid.maxCollaboratorsPerProject === null) {
        await invite('more@example.org').expect(201);
      } else {
        await invite('more@example.org').expect(402, { code: 'collaborator_limit' });
        // A supervisor never counts (submission to a supervisor in every plan).
        await invite('supervisor@example.org', 'SUPERVISOR').expect(201);
      }
      const sharing = (await as(owner).get(`projects/${projectId}/sharing`).expect(200)).body;
      expect(sharing.collaborators).toEqual({
        used: grid.maxCollaboratorsPerProject === null ? max + 1 : max,
        max: grid.maxCollaboratorsPerProject,
      });
    });

    it(`compilation duration: ${grid.maxCompileSeconds} s, priority ${grid.compilePriority}`, async () => {
      const compilation = (await compile().expect(201)).body as Compilation;
      const job = ctx.queue.jobs.get(compilation.id)!;
      expect(job.data.timeoutSeconds).toBe(grid.maxCompileSeconds);
      expect(job.priority).toBe(COMPILE_PRIORITY_RANK[grid.compilePriority!]);
      expect(ctx.db.compilations[0]).toMatchObject({
        priority: grid.compilePriority,
        chargedUserId: owner.id,
      });
      expect((await usage()).limits).toMatchObject({
        maxCompileSeconds: grid.maxCompileSeconds,
        compilePriority: grid.compilePriority,
      });
    });

    it(`compilations per hour: ${grid.maxCompilesPerHour}`, async () => {
      const max = grid.maxCompilesPerHour!;
      // The hour already holds max - 1 compilations of the owner (sliding window in Redis).
      const now = Date.now();
      const key = compileHourKey(owner.id);
      for (let index = 0; index < max - 1; index++) {
        await redis.client.zadd(key, now - 1000 - index, `earlier-${index}`);
      }
      const last = (await compile().expect(201)).body as Compilation;
      ctx.queue.jobs.get(last.id)!.state = 'active';
      const refused = await compile().expect(429);
      expect(refused.body.code).toBe('compile_limit');
      expect(refused.body.retryAfter).toBeGreaterThan(3500);
      expect((await usage()).compilesPerHour).toMatchObject({ used: max, max, level: 'full' });
    });

    it(`storage: ${Number(grid.storageBytes! / MIB)} MiB`, async () => {
      await fillStorage(code, 10n);
      await as(owner).upload('fits.txt', 10).expect(200);
      await as(owner).upload('too-much.txt', 1).expect(402, { code: 'storage_limit' });
      expect((await usage()).storage).toMatchObject({
        used: Number(grid.storageBytes),
        max: Number(grid.storageBytes),
        level: 'full',
      });
      // Shrinking a file stays possible at the limit (docs/spec.md, "Stockage au-delà").
      await as(owner).upload('fits.txt', 4).expect(200);
    });

    it(`version history: ${grid.historyDays ?? 'unlimited'} days`, async () => {
      const name = (label: string) =>
        as(owner).post(`projects/${projectId}/versions`, { label }).expect(201);
      const inside = (await name('inside')).body;
      const outside = (await name('outside')).body;
      const days = grid.historyDays ?? 3650;
      const version = (id: string) => ctx.db.versions.find((row) => row.id === id)!;
      version(inside.id).createdAt = new Date(Date.now() - (days * DAY_MS - 3600_000));
      version(outside.id).createdAt = new Date(Date.now() - (days * DAY_MS + 3600_000));
      const list = (await as(owner).get(`projects/${projectId}/versions`).expect(200)).body;
      const labels = list.versions.map((v: { label: string }) => v.label);
      expect(labels).toContain('inside');
      if (grid.historyDays === null) {
        expect(labels).toContain('outside');
      } else {
        expect(labels).not.toContain('outside');
        expect(list.hiddenCount).toBe(1);
      }
      expect(list.historyDays).toBe(grid.historyDays);
    });

    it(`automatic compilation: ${grid.autoCompile ? 'yes' : 'no'}`, async () => {
      if (grid.autoCompile) await compile({ auto: true }).expect(201);
      else await compile({ auto: true }).expect(403, { code: 'auto_compile_unavailable' });
      const state = (await as(owner).get(`projects/${projectId}/compile`).expect(200)).body;
      expect(state.autoCompile).toBe(grid.autoCompile);
      expect((await usage()).limits.autoCompile).toBe(grid.autoCompile);
    });

    it(`supervision dashboard: ${grid.supervisionDashboard ? 'yes, 30 students' : 'no'}`, async () => {
      // The dashboard itself comes with step 12; its quota is read from the plan already.
      expect((await usage()).limits).toMatchObject({
        supervisionDashboard: grid.supervisionDashboard,
        maxSupervisedStudents: grid.maxSupervisedStudents,
      });
    });
  });

  describe('several seats: the best quota wins, never pooled', () => {
    it('takes the best value of each quota of FREE, STANDARD and a TEAM seat', async () => {
      hold(owner, 'STANDARD');
      hold(owner, 'TEAM');
      const result = await usage();
      expect(result.plan.code).toBe('TEAM');
      expect(result.sources.map((source) => [source.kind, source.planCode])).toEqual([
        ['free', 'FREE'],
        ['personal', 'STANDARD'],
        ['seat', 'TEAM'],
      ]);
      expect(result.sources[2]!.organizationName).toBe('Université Joseph Ki-Zerbo');
      expect(result.storage.max).toBe(Number(5n * GIB)); // 5 GiB, not 2 + 5
      expect(result.limits).toMatchObject({
        maxCollaborators: null,
        maxCompileSeconds: 240,
        historyDays: null,
        compilePriority: 'HIGH',
      });
      expect(result.compilesPerHour.max).toBe(200);
    });

    it('charges a shared project to its owner, never to the editor', async () => {
      const editor = ctx.db.addUser('Issa Traoré');
      hold(editor, 'BUSINESS');
      ctx.db.share(projectId, editor.id, 'EDITOR');
      const compilation = (await as(editor).post(`projects/${projectId}/compile`).expect(201))
        .body as Compilation;
      // Owner on FREE: 20 s and low priority, whatever the editor holds.
      expect(ctx.queue.jobs.get(compilation.id)!.data.timeoutSeconds).toBe(20);
      expect(await redis.client.zcard(compileHourKey(owner.id))).toBe(1);
      expect(await redis.client.zcard(compileHourKey(editor.id))).toBe(0);
    });

    it('ignores a subscription whose period and grace are over, even before its status changes', async () => {
      hold(owner, 'STANDARD');
      ctx.db.subscriptionDates.set(owner.id, {
        status: 'ACTIVE',
        currentPeriodEnd: new Date(Date.now() - 8 * DAY_MS),
        graceEndsAt: null,
      });
      expect((await usage()).plan.code).toBe('FREE');
      // Within the 7 days of grace, the plan still applies.
      ctx.db.subscriptionDates.set(owner.id, {
        status: 'ACTIVE',
        currentPeriodEnd: new Date(Date.now() - 6 * DAY_MS),
        graceEndsAt: null,
      });
      expect((await usage()).plan.code).toBe('STANDARD');
    });
  });

  describe('usage counters of the month', () => {
    it('counts every finished compilation and its seconds on the owner', async () => {
      const first = (await compile().expect(201)).body as Compilation;
      ctx.queue.jobs.get(first.id)!.state = 'active';
      const done = {
        outcome: 'success' as const,
        durationMs: 61_500,
        issues: [],
        errorCount: 0,
        warningCount: 0,
        pdfBytes: null,
        log: false,
        synctex: false,
        worker: 'w1',
      };
      await ctx.queue.handlers!.completed(first.id, done);
      await ctx.queue.handlers!.completed(first.id, done); // a repeated event is not counted twice
      const second = (await compile().expect(201)).body as Compilation;
      await ctx.queue.handlers!.completed(second.id, {
        ...done,
        outcome: 'timeout',
        durationMs: 20_000,
      });
      expect((await usage()).month).toMatchObject({ compileCount: 2, compileSeconds: 61 + 20 });
    });
  });

  describe('alerts at 80 % and 100 %', () => {
    it('notifies in the app once per quota, level and month', async () => {
      await newProject(owner, 'Deux').expect(201); // 2 of 3 projects: 67 %
      await ctx.app.get(UsageAlertsService).idle();
      expect(ctx.db.notifications).toHaveLength(0);
      await newProject(owner, 'Trois').expect(201); // 3 of 3: 80 % and 100 % passed
      await ctx.app.get(UsageAlertsService).idle();
      const alerts = () =>
        ctx.db.notifications.map((row) => [
          (row.payload as { quota: string }).quota,
          (row.payload as { level: string }).level,
        ]);
      expect(alerts()).toEqual([
        ['projects', 'warn'],
        ['projects', 'full'],
      ]);
      expect(ctx.db.notifications[0]).toMatchObject({
        userId: owner.id,
        channel: 'IN_APP',
        type: 'QUOTA_ALERT',
      });
      // Back under the limit and full again: no second notification this month.
      const last = ctx.db.projects.at(-1)!.id;
      await as(owner).post(`projects/${last}/trash`).expect(204);
      await as(owner).post(`projects/${last}/restore`).expect(204);
      await ctx.app.get(UsageAlertsService).idle();
      expect(ctx.db.notifications).toHaveLength(2);

      await fillStorage('FREE', 10n * MIB); // 90 MiB of 100
      await as(owner).upload('note.txt', 10).expect(200);
      await ctx.app.get(UsageAlertsService).idle();
      expect(alerts()).toContainEqual(['storage', 'warn']);
      expect(alerts()).not.toContainEqual(['storage', 'full']);
    });
  });

  describe('end of a subscription: read-only beyond the FREE limits, nothing deleted', () => {
    const limits = () => ctx.app.get(PlanLimitsService);
    const states = () =>
      Object.fromEntries(ctx.db.projects.map((p) => [p.name, p.readOnlyReason !== null]));
    const touch = (name: string, daysAgo: number) => {
      ctx.db.projects.find((p) => p.name === name)!.lastActivityAt = new Date(
        Date.now() - daysAgo * DAY_MS,
      );
    };

    beforeEach(async () => {
      hold(owner, 'STANDARD');
      for (const name of ['B', 'C', 'D', 'E']) await newProject(owner, name).expect(201);
      // Mémoire is the most recent, then E, D, C, B.
      ['Mémoire', 'E', 'D', 'C', 'B'].forEach((name, index) => touch(name, index));
      ctx.db.personalPlans.delete(owner.id); // the subscription ended (grace over)
      await limits().reconcile(owner.id);
    });

    it('keeps the 3 most recently active projects writable, and the choice stays fixed', async () => {
      expect(states()).toEqual({ Mémoire: false, B: true, C: true, D: false, E: false });
      expect(ctx.db.projects.filter((p) => p.readOnlyReason).map((p) => p.readOnlyReason)).toEqual([
        READ_ONLY_REASONS.overPlanLimit,
        READ_ONLY_REASONS.overPlanLimit,
      ]);
      // Activity on a read-only project does not change the choice.
      touch('B', -1);
      await limits().reconcile(owner.id);
      expect(states()).toMatchObject({ B: true, D: false });
      expect(await usage()).toMatchObject({
        projects: { used: 5, max: 3, level: 'full' },
      });
    });

    it('lets the read-only projects be read, downloaded, commented and shared for reading only', async () => {
      const id = ctx.db.projects.find((p) => p.name === 'B')!.id;
      await as(owner).get(`projects/${id}`).expect(200);
      await as(owner).post(`projects/${id}/compile`).expect(403, { code: 'read_only' });
      await as(owner).upload('x.tex', 3, id).expect(403, { code: 'read_only' });
      await as(owner)
        .post(`projects/${id}/invitations`, {
          channel: 'email',
          email: 'e@example.org',
          role: 'EDITOR',
        })
        .expect(409, { code: 'read_only_editor' });
      await as(owner)
        .post(`projects/${id}/invitations`, {
          channel: 'email',
          email: 'v@example.org',
          role: 'VIEWER',
        })
        .expect(201);
      const member = ctx.db.addUser('Lecteur');
      ctx.db.share(id, member.id, 'VIEWER');
      await as(owner)
        .patch(`projects/${id}/members/${member.id}`, { role: 'EDITOR' })
        .expect(409, { code: 'read_only_editor' });
      await as(owner)
        .patch(`projects/${id}/members/${member.id}`, { role: 'REVIEWER' })
        .expect(200);
      const sharing = (await as(owner).get(`projects/${id}/sharing`).expect(200)).body;
      expect(sharing.readOnly).toBe(true);
      // Nothing was deleted.
      expect(ctx.db.projects).toHaveLength(5);
    });

    it('swaps a writable project for a read-only one, and the trash frees a place', async () => {
      const id = (name: string) => ctx.db.projects.find((p) => p.name === name)!.id;
      await as(owner)
        .post(`projects/${id('B')}/writable`)
        .expect(409, { code: 'release_required' });
      await as(owner)
        .post(`projects/${id('B')}/writable`, { release: id('C') })
        .expect(422, { code: 'invalid_release' });
      await as(owner)
        .post(`projects/${id('B')}/writable`, { release: id('D') })
        .expect(204);
      expect(states()).toEqual({ Mémoire: false, B: false, C: true, D: true, E: false });
      await as(owner)
        .post(`projects/${id('Mémoire')}/writable`)
        .expect(409, { code: 'not_read_only' });
      const stranger = ctx.db.addUser('Inconnu');
      await as(stranger)
        .post(`projects/${id('C')}/writable`)
        .expect(404);

      // The trash frees a place: the most recently active read-only project (D) takes it.
      await as(owner)
        .post(`projects/${id('E')}/trash`)
        .expect(204);
      expect(states()).toMatchObject({ B: false, C: true, D: false });
      const list = await usage();
      expect(list.writable.map((p) => p.name)).toEqual(['Mémoire', 'D', 'B']);
      expect(list.readOnly.map((p) => p.name)).toEqual(['C']);
    });

    it('makes everything writable again with a higher plan', async () => {
      hold(owner, 'TEAM');
      await limits().reconcile(owner.id);
      expect(Object.values(states()).every((readOnly) => !readOnly)).toBe(true);
    });
  });
});
