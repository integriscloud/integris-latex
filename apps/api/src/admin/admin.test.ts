import { planTermsOf, type PlanTerms } from '@integris/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NotificationQueue } from '../notifications/notification-queue.service.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { PlansModule } from '../plans/plans.module.js';
import { QuotaService } from '../projects/quota.service.js';
import {
  type BillingTestApp,
  createBillingTestApp,
  TEST_ADMIN_REAUTH_HEADER,
} from '../test/billing-app.js';
import { TEST_USER_HEADER } from '../test/projects-app.js';
import { AdminModule } from './admin.module.js';

const DAY_MS = 86_400_000;
const ORIGIN = 'http://127.0.0.1:3000';

let t: BillingTestApp;
type Row = Record<string, unknown>;
let admin: Row;
let user: Row;

beforeAll(async () => {
  t = await createBillingTestApp({}, [AdminModule, OrganizationsModule, PlansModule]);
});

afterAll(async () => {
  await t.app.close();
});

beforeEach(() => {
  t.db.reset();
  t.db.addPlans();
  t.outbox.sms = [];
  t.outbox.mails = [];
  admin = t.db.addUser({
    displayName: 'Admin Integris',
    phone: '+22670000001',
    isSuperAdmin: true,
  });
  user = t.db.addUser({
    displayName: 'Awa Ouédraogo',
    phone: '+22670000002',
    email: 'awa@example.com',
    emailVerifiedAt: new Date(),
  });
});

const as = (who: Row, reauth = false) => {
  const headers = (req: request.Test) => {
    req.set(TEST_USER_HEADER, who.id as string).set('Origin', ORIGIN);
    if (reauth) req.set(TEST_ADMIN_REAUTH_HEADER, '1');
    return req;
  };
  const server = t.app.getHttpServer();
  return {
    get: (path: string) => headers(request(server).get(`/api${path}`)),
    post: (path: string, body: object = {}) =>
      headers(request(server).post(`/api${path}`)).send(body),
    put: (path: string, body: object) => headers(request(server).put(`/api${path}`)).send(body),
    patch: (path: string, body: object) => headers(request(server).patch(`/api${path}`)).send(body),
  };
};

const standardTerms = (): PlanTerms =>
  planTermsOf(
    t.db.rows('plan', { code: 'STANDARD' })[0] as unknown as Parameters<typeof planTermsOf>[0],
  );

describe('access', () => {
  it('hides the back-office from anyone but a super-administrator', async () => {
    const refused = await as(user).get('/admin/plans').expect(404);
    expect(refused.body.code).toBe('admin_not_found');
    await as(user, true)
      .put('/admin/plans/STANDARD', { terms: standardTerms(), reason: 'test' })
      .expect(404);
  });

  it('journals every consultation', async () => {
    const plans = (await as(admin).get('/admin/plans').expect(200)).body;
    expect(plans.map((plan: { code: string }) => plan.code)).toEqual([
      'FREE',
      'STANDARD',
      'TEAM',
      'BUSINESS',
    ]);
    expect(plans[1].version).toBe(1);
    const audit = t.db.rows('auditLog', { action: 'ADMIN_VIEWED', actorId: admin.id });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.targetId).toBe('/api/admin/plans');
  });

  it('needs a recent SMS code for sensitive actions', async () => {
    const terms = { ...standardTerms(), priceMonthlyXof: 2500 };
    const refused = await as(admin).put('/admin/plans/STANDARD', { terms, reason: 'Hausse' });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('admin_reauth_required');
    expect(t.db.rows('plan', { code: 'STANDARD' })[0]!.priceMonthlyXof).toBe(2000);

    await as(admin).post('/admin/reauth/otp', { locale: 'fr' }).expect(200);
    const code = /(\d{6})/.exec(t.outbox.sms.at(-1)!.text)![1]!;
    expect((await as(admin).post('/admin/reauth', { code: '000000' })).status).toBe(400);
    const ok = await as(admin).post('/admin/reauth', { code }).expect(200);
    expect(ok.body.reauthUntil).toBeGreaterThan(Date.now() / 1000);
    expect(
      t.db
        .rows('auditLog', { actorId: admin.id, targetType: 'BackOffice' })
        .map((row) => row.action),
    ).toEqual(['ADMIN_REAUTH_REQUESTED', 'ADMIN_REAUTH_CONFIRMED']);
    // A malformed id is a bad request, never a server error.
    await as(admin)
      .get(`/admin/users/${'x'.repeat(80)}`)
      .expect(400);
  });
});

describe('plans', () => {
  it('changes a price with a new version and its history, read by the public grid', async () => {
    const terms = { ...standardTerms(), priceMonthlyXof: 2500 };
    const history = (
      await as(admin, true)
        .put('/admin/plans/STANDARD', { terms, reason: 'Nouveau tarif' })
        .expect(200)
    ).body;
    expect(history[0]).toMatchObject({
      version: 2,
      reason: 'Nouveau tarif',
      changed: ['priceMonthlyXof'],
    });
    expect(history[0].changedBy).toBe('Admin Integris');
    expect(history[1].version).toBe(1);
    const audit = t.db.rows('auditLog', { action: 'ADMIN_PLAN_UPDATED' })[0]!;
    expect(audit.metadata).toMatchObject({
      code: 'STANDARD',
      version: 2,
      changes: { priceMonthlyXof: { from: 2000, to: 2500 } },
    });
    const grid = (await request(t.app.getHttpServer()).get('/api/plans').expect(200)).body;
    expect(grid.find((plan: { code: string }) => plan.code === 'STANDARD').priceMonthlyXof).toBe(
      2500,
    );
  });

  it('refuses terms that break the grid', async () => {
    const free = planTermsOf(t.db.rows('plan', { code: 'FREE' })[0] as never);
    const paidFree = await as(admin, true).put('/admin/plans/FREE', {
      terms: { ...free, priceMonthlyXof: 500 },
      reason: 'Erreur',
    });
    expect(paidFree.status).toBe(422);
    expect(paidFree.body.code).toBe('plan_terms_invalid');
    const seats = await as(admin, true).put('/admin/plans/STANDARD', {
      terms: { ...standardTerms(), maxSeats: 3 },
      reason: 'Erreur',
    });
    expect(seats.status).toBe(422);
    expect(t.db.rows('planRevision', { planId: 'STANDARD' })).toHaveLength(1);
  });

  it('applies a higher quota at once, a lower one at the next paid period, FREE at once', async () => {
    t.db.insert('subscription', {
      planId: 'STANDARD',
      userId: user.id,
      status: 'ACTIVE',
      billingPeriod: 'MONTHLY',
      currentPeriodStart: new Date(Date.now() - DAY_MS),
      currentPeriodEnd: new Date(Date.now() + 20 * DAY_MS),
      planRevisionId: 'rev1_STANDARD',
    });
    const free = t.db.addUser({ displayName: 'Free user' });
    await as(admin, true)
      .put('/admin/plans/STANDARD', {
        terms: { ...standardTerms(), maxCollaboratorsPerProject: 3, maxCompilesPerHour: 300 },
        reason: 'Grille 2027',
      })
      .expect(200);
    const freeTerms = planTermsOf(t.db.rows('plan', { code: 'FREE' })[0] as never);
    await as(admin, true)
      .put('/admin/plans/FREE', {
        terms: { ...freeTerms, maxProjects: 2 },
        reason: 'Gratuit réduit',
      })
      .expect(200);
    const quota = t.app.get(QuotaService);
    const paid = await quota.quotas(user.id as string);
    expect(paid.maxCollaborators).toBe(5);
    expect(paid.maxCompilesPerHour).toBe(300);
    expect((await quota.quotas(free.id as string)).maxProjects).toBe(2);
  });

  it('prices extra seats at the price of the current period, a new order at the new price', async () => {
    const organization = t.db.insert('organization', { type: 'TEAM', name: 'Labo' });
    t.db.insert('membership', { organizationId: organization.id, userId: user.id, role: 'OWNER' });
    const subscription = t.db.insert('subscription', {
      planId: 'TEAM',
      organizationId: organization.id,
      status: 'ACTIVE',
      billingPeriod: 'MONTHLY',
      seatCount: 2,
      currentPeriodStart: new Date(Date.now() - 10 * DAY_MS),
      currentPeriodEnd: new Date(Date.now() + 20 * DAY_MS),
      planRevisionId: 'rev1_TEAM',
    });
    const quote = (order: object) =>
      as(user).post('/billing/quote', { order, locale: 'fr' }).expect(200);
    const seats = { kind: 'SEATS', subscriptionId: subscription.id, seats: 1 };
    const newOrder = {
      kind: 'NEW',
      plan: 'TEAM',
      period: 'MONTHLY',
      seats: 2,
      organization: { name: 'Autre labo' },
    };
    const before = (await quote(seats)).body;
    expect((await quote(newOrder)).body.base).toBe(5000);
    const team = planTermsOf(t.db.rows('plan', { code: 'TEAM' })[0] as never);
    await as(admin, true)
      .put('/admin/plans/TEAM', { terms: { ...team, priceMonthlyXof: 3000 }, reason: 'Hausse' })
      .expect(200);
    expect((await quote(seats)).body.base).toBe(before.base);
    expect((await quote(newOrder)).body.base).toBe(6000);
  });
});

describe('credits and refunds', () => {
  it('adds credit and records refunds within the balance, telling the payer', async () => {
    await as(admin, true)
      .post(`/admin/users/${user.id}/credits`, { amountXof: 1000, note: 'Geste commercial' })
      .expect(201);
    expect(t.db.creditBalance(user.id as string)).toBe(1000);
    expect(t.db.rows('creditEntry', { reason: 'ADMIN_CREDIT' })[0]).toMatchObject({
      createdById: admin.id,
      note: 'Geste commercial',
    });
    const duplicate = t.db.insert('payment', {
      userId: user.id,
      purpose: 'NEW_SUBSCRIPTION',
      planCode: 'STANDARD',
      billingPeriod: 'MONTHLY',
      amountXof: 2000,
      breakdown: {},
      order: {},
      status: 'CREDITED',
    });
    t.db.insert('creditEntry', {
      userId: user.id,
      amountXof: 2000,
      reason: 'DUPLICATE_PAYMENT',
      paymentId: duplicate.id,
    });
    const tooMuch = await as(admin, true).post(`/admin/users/${user.id}/refunds`, {
      amountXof: 3500,
      note: 'Remboursement',
      reference: 'OM-123',
    });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.code).toBe('credit_insufficient');
    const partial = await as(admin, true).post(`/admin/users/${user.id}/refunds`, {
      amountXof: 500,
      note: 'Partiel',
      reference: 'OM-1',
      paymentId: duplicate.id,
    });
    expect(partial.body.code).toBe('refund_below_payment');
    const detail = (
      await as(admin, true)
        .post(`/admin/users/${user.id}/refunds`, {
          amountXof: 2000,
          note: 'Doublon remboursé',
          reference: 'OM-456',
          paymentId: duplicate.id,
        })
        .expect(201)
    ).body;
    expect(detail.creditBalance).toBe(1000);
    // Rows are copies again after a refused transaction (FakeBillingDb snapshot): read them anew.
    expect(t.db.rows('payment', { id: duplicate.id })[0]!.status).toBe('REFUNDED');
    expect(t.db.rows('auditLog', { action: 'ADMIN_CREDIT_REFUNDED' })[0]!.metadata).toMatchObject({
      amountXof: 2000,
      reference: 'OM-456',
    });
    // The payer is told in the application and by e-mail (whatever their preferences), no SMS.
    expect(
      t.db.rows('notification', { userId: user.id, channel: 'IN_APP' }).map((row) => row.type),
    ).toEqual(['CREDIT_ADDED', 'CREDIT_REFUNDED']);
    await t.app.get(NotificationQueue).flush();
    expect(t.outbox.mails.map((mail) => mail.to)).toEqual(['awa@example.com', 'awa@example.com']);
    expect(t.outbox.sms).toHaveLength(0);
  });

  it('never shows project contents in the user page', async () => {
    t.db.insert('project', { ownerId: user.id, name: 'Mémoire secret' });
    const detail = (await as(admin).get(`/admin/users/${user.id}`).expect(200)).body;
    expect(detail.usage.projects).toBe(1);
    expect(JSON.stringify(detail)).not.toContain('Mémoire secret');
  });
});

describe('BUSINESS pilot trials', () => {
  it('starts once per owner, extends up to 60 days, and is paid from its end', async () => {
    const started = (
      await as(admin, true)
        .post('/admin/business-trials', { ownerId: user.id, organizationName: 'Université pilote' })
        .expect(201)
    ).body;
    expect(started.seats).toEqual({ total: 10, used: 1 });
    expect(started.trial.extendableDays).toBe(30);
    const subscription = t.db.rows('subscription', { organizationId: started.organization.id })[0]!;
    expect(subscription).toMatchObject({
      status: 'TRIALING',
      seatCount: 10,
      planRevisionId: 'rev1_BUSINESS',
    });
    expect(t.db.rows('seat', { subscriptionId: subscription.id })).toHaveLength(10);
    expect(
      t.db.rows('notification', { userId: user.id, type: 'BUSINESS_TRIAL_STARTED' }),
    ).toHaveLength(1);

    const again = await as(admin, true).post('/admin/business-trials', {
      ownerId: user.id,
      organizationName: 'Deuxième',
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('business_trial_used');

    const extend = (days: number) =>
      as(admin, true).post(`/admin/organizations/${started.organization.id}/trial-extension`, {
        days,
        reason: 'Bon de commande en attente',
      });
    expect((await extend(20)).body.trial.extendableDays).toBe(10);
    const tooLong = await extend(15);
    expect(tooLong.status).toBe(409);
    expect(tooLong.body.code).toBe('business_trial_limit');
    await extend(10).expect(201);
    expect(t.db.rows('auditLog', { action: 'ADMIN_BUSINESS_TRIAL_EXTENDED' })).toHaveLength(2);

    // The owner pays during the trial: the paid period starts at its end.
    const quote = (
      await as(user)
        .post('/billing/quote', {
          order: {
            kind: 'RENEW',
            subscriptionId: subscription.id,
            plan: 'BUSINESS',
            period: 'YEARLY',
            seats: 10,
          },
          locale: 'fr',
        })
        .expect(200)
    ).body;
    const trial = t.db.rows('subscription', { id: subscription.id })[0]!;
    expect(new Date(quote.periodStart)).toEqual(trial.currentPeriodEnd);
  });

  it('reminds the owner and the admins 7 and 3 days before the end', async () => {
    const started = (
      await as(admin, true)
        .post('/admin/business-trials', { ownerId: user.id, organizationName: 'Université pilote' })
        .expect(201)
    ).body;
    const { BillingScheduler } = await import('../billing/billing-scheduler.service.js');
    const scheduler = t.app.get(BillingScheduler);
    const end = new Date(started.organization.subscription.currentPeriodEnd).getTime();
    expect(await scheduler.businessTrialReminders(new Date(end - 8 * DAY_MS))).toBe(0);
    expect(await scheduler.businessTrialReminders(new Date(end - 6 * DAY_MS))).toBe(1);
    expect(await scheduler.businessTrialReminders(new Date(end - 5 * DAY_MS))).toBe(0);
    expect(await scheduler.businessTrialReminders(new Date(end - 2 * DAY_MS))).toBe(1);
    await t.app.get(NotificationQueue).flush();
    expect(t.outbox.sms.map((sms) => sms.to)).toEqual(['+22670000002', '+22670000002']);
    expect(t.outbox.sms[0]!.text).not.toContain('Université pilote');
  });
});

describe('promo codes', () => {
  it('creates codes, locks their terms after use and keeps the count', async () => {
    const created = (
      await as(admin, true)
        .post('/admin/promo-codes', {
          code: 'rentree-2027',
          percentOff: 20,
          planCodes: ['STANDARD'],
          validUntil: new Date(Date.now() + 30 * DAY_MS).toISOString(),
          maxRedemptions: 100,
        })
        .expect(201)
    ).body;
    expect(created[0]).toMatchObject({ code: 'RENTREE-2027', percentOff: 20, redemptionCount: 0 });
    const twice = await as(admin, true).post('/admin/promo-codes', {
      code: 'RENTREE-2027',
      percentOff: 10,
      planCodes: [],
      validUntil: null,
      maxRedemptions: null,
    });
    expect(twice.body.code).toBe('promo_code_taken');
    const promo = t.db.rows('promoCode')[0]!;
    promo.redemptionCount = 3;
    const locked = await as(admin, true).patch(`/admin/promo-codes/${promo.id}`, {
      percentOff: 50,
    });
    expect(locked.body.code).toBe('promo_locked');
    const below = await as(admin, true).patch(`/admin/promo-codes/${promo.id}`, {
      maxRedemptions: 2,
    });
    expect(below.body.code).toBe('promo_max_below_used');
    await as(admin, true).patch(`/admin/promo-codes/${promo.id}`, { isActive: false }).expect(200);
    expect(t.db.rows('promoCode', { id: promo.id })[0]!.isActive).toBe(false);
  });
});

describe('statistics', () => {
  it('counts accounts, paying accounts, revenue and compilations', async () => {
    t.db.insert('subscription', {
      planId: 'STANDARD',
      userId: user.id,
      status: 'ACTIVE',
      billingPeriod: 'MONTHLY',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 20 * DAY_MS),
    });
    t.db.insert('payment', {
      userId: user.id,
      purpose: 'NEW_SUBSCRIPTION',
      planCode: 'STANDARD',
      billingPeriod: 'MONTHLY',
      amountXof: 2000,
      breakdown: {},
      order: {},
      status: 'SUCCEEDED',
      verifiedAt: new Date(),
    });
    t.db.insert('creditEntry', { userId: user.id, amountXof: -500, reason: 'REFUNDED' });
    const stats = (await as(admin).get('/admin/stats').expect(200)).body;
    expect(stats.totals).toMatchObject({ users: 2, payingUsers: 1, revenueXof: 1500 });
    expect(stats.months).toHaveLength(12);
    expect(stats.months.at(-1)).toMatchObject({ signups: 2, revenueXof: 1500 });
  });
});
