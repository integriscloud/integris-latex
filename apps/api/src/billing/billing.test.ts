import { addPeriod } from '@integris/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type BillingTestApp, createBillingTestApp } from '../test/billing-app.js';
import { NotificationQueue } from '../notifications/notification-queue.service.js';
import { TEST_USER_HEADER } from '../test/projects-app.js';
import { BillingScheduler } from './billing-scheduler.service.js';
import { paymentIdOf } from './ligdicash-callback.controller.js';
import { isLigdicashPage } from './ligdicash.provider.js';
import { PaymentProcessor } from './payment-processor.service.js';

const ORIGIN = 'http://127.0.0.1:3000';
const DAY_MS = 86_400_000;
const CALLBACK = '/api/payments/ligdicash/callback';

let t: BillingTestApp;

/** SMS and e-mails of the notifications leave through the queue (sent at once in tests). */
const flushNotifications = () => t.app.get(NotificationQueue).flush();
let user: Record<string, unknown>;

const standardYearly = { kind: 'NEW', plan: 'STANDARD', period: 'YEARLY', seats: 1 };

const as = (who: Record<string, unknown>) => ({
  get: (path: string) =>
    request(t.app.getHttpServer())
      .get(`/api${path}`)
      .set(TEST_USER_HEADER, who.id as string),
  post: (path: string, body: object = {}) =>
    request(t.app.getHttpServer())
      .post(`/api${path}`)
      .set(TEST_USER_HEADER, who.id as string)
      .set('Origin', ORIGIN)
      .send(body),
});

const checkout = (order: object, who = user) =>
  as(who).post('/billing/checkout', { order, locale: 'fr' });
const quote = (order: object, who = user) =>
  as(who).post('/billing/quote', { order, locale: 'fr' });

/** LigdiCash calls back twice, JSON then form, without any origin or session. */
async function callBack(paymentId: string) {
  const server = t.app.getHttpServer();
  await request(server)
    .post(CALLBACK)
    .send({
      status: 'completed',
      token: '',
      custom_data: [{ keyof_customdata: 'transaction_id', valueof_customdata: paymentId }],
    })
    .expect(200);
  await request(server)
    .post(CALLBACK)
    .type('form')
    .send(
      `status=completed&custom_data[0][keyof_customdata]=transaction_id&custom_data[0][valueof_customdata]=${paymentId}`,
    )
    .expect(200);
}

/** Checkout, LigdiCash payment and callback: the usual path. */
async function pay(order: object, who = user) {
  const response = await checkout(order, who).expect(201);
  const paymentId = response.body.paymentId as string;
  if (response.body.redirectUrl) {
    t.provider.pay(`tok_${t.provider.invoices.length}`);
    await callBack(paymentId);
  }
  return t.db.rows('payment', { id: paymentId })[0]!;
}

const verifiedUser = (data: Record<string, unknown> = {}) =>
  t.db.addUser({
    phone: `+2267${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
    email: `u${Math.random().toString(36).slice(2)}@integris.test`,
    emailVerifiedAt: new Date(),
    ...data,
  });

beforeAll(async () => {
  t = await createBillingTestApp();
});

afterAll(async () => {
  await t.app.close();
});

beforeEach(() => {
  t.db.reset();
  t.db.addPlans();
  t.provider.invoices = [];
  t.provider.statuses.clear();
  t.outbox.mails = [];
  t.outbox.sms = [];
  t.reconciled.length = 0;
  user = verifiedUser();
});

describe('quotes', () => {
  it('prices from the Plan table, never from the client', async () => {
    const response = await quote(standardYearly).expect(200);
    expect(response.body).toMatchObject({ base: 20000, total: 20000, emailRequired: false });
    t.db.rows('plan', { code: 'STANDARD' })[0]!.priceYearlyXof = 18000;
    expect((await quote(standardYearly)).body.total).toBe(18000);
    await quote({ ...standardYearly, total: 1 }).expect(200);
    expect((await quote({ ...standardYearly, seats: 2 })).body.code).toBe('invalid_seats');
    expect((await quote({ ...standardYearly, plan: 'FREE' })).status).toBe(400);
  });

  it('asks for the organization of a TEAM or BUSINESS and checks its seats', async () => {
    const team = { kind: 'NEW', plan: 'TEAM', period: 'MONTHLY', seats: 4 };
    expect((await quote(team)).body.code).toBe('organization_required');
    const named = { ...team, organization: { name: 'Labo Maths' } };
    expect((await quote(named)).body.total).toBe(10000);
    expect((await quote({ ...named, seats: 11 })).body.code).toBe('invalid_seats');
    const business = { ...named, plan: 'BUSINESS', seats: 9 };
    expect((await quote(business)).body.code).toBe('invalid_seats');
    expect((await quote({ ...business, seats: 150, period: 'YEARLY' })).body.total).toBe(3_000_000);
  });
});

describe('checkout and LigdiCash callback', () => {
  it('requires a verified e-mail (receipts go by e-mail only)', async () => {
    const noEmail = t.db.addUser({ phone: '+22670000001' });
    expect((await checkout(standardYearly, noEmail)).body.code).toBe('email_required');
    expect((await quote(standardYearly, noEmail)).body.emailRequired).toBe(true);
  });

  it('activates only after LigdiCash confirms, once, with a receipt by e-mail', async () => {
    const response = await checkout(standardYearly).expect(201);
    expect(response.body.redirectUrl).toBe('https://ligdicash.test/pay/invoice/tok_1');
    const invoice = t.provider.invoices[0]!;
    expect(invoice).toMatchObject({
      amountXof: 20000,
      callbackUrl: 'http://127.0.0.1:3000/api/payments/ligdicash/callback',
      paymentId: response.body.paymentId,
    });
    expect(Number.isInteger(invoice.amountXof)).toBe(true);

    // A callback claiming success while LigdiCash still says pending changes nothing.
    await callBack(response.body.paymentId);
    expect(t.db.rows('subscription')).toHaveLength(0);

    t.provider.pay('tok_1');
    // JSON and form callbacks at the same time, plus the status page: one activation.
    await Promise.all([
      callBack(response.body.paymentId),
      callBack(response.body.paymentId),
      as(user).get(`/billing/payments/${response.body.paymentId}`),
    ]);
    const [subscription] = t.db.rows('subscription');
    expect(t.db.rows('subscription')).toHaveLength(1);
    expect(subscription).toMatchObject({
      status: 'ACTIVE',
      billingPeriod: 'YEARLY',
      paidValueXof: 20000,
      userId: user.id,
    });
    expect(t.db.rows('payment')[0]).toMatchObject({
      status: 'SUCCEEDED',
      providerTransactionId: 'LC-tok_1',
    });
    expect(t.db.rows('auditLog', { action: 'PAYMENT_VERIFIED' })).toHaveLength(1);
    expect(t.db.rows('receipt')).toHaveLength(1);
    expect(t.db.rows('receipt')[0]).toMatchObject({ number: 1 });
    // The VAT rate of the payment is kept: a later change of VAT_RATE_PERCENT leaves it alone.
    expect(t.db.rows('payment')[0]!.breakdown).toMatchObject({ vatRatePercent: 0 });
    const mail = t.outbox.mails.find((item) => item.subject.includes('000001'))!;
    expect(mail.to).toBe(user.email);
    expect(mail.attachments?.[0]).toMatchObject({
      filename: 'integris-latex-000001.pdf',
      contentType: 'application/pdf',
    });
    const pdf = Buffer.from(mail.attachments![0]!.content).toString('latin1');
    expect(pdf.startsWith('%PDF-')).toBe(true);
    expect(t.storage.objects.has('receipts/000001.pdf')).toBe(true);
    expect(t.reconciled).toContain(user.id);

    const status = await as(user).get(`/billing/payments/${response.body.paymentId}`).expect(200);
    expect(status.body).toMatchObject({ status: 'SUCCEEDED', receiptNumber: 1, amountXof: 20000 });
  });

  it('ignores forged or unknown callbacks and refuses another amount', async () => {
    const server = t.app.getHttpServer();
    await request(server).post(CALLBACK).send({ status: 'completed' }).expect(200);
    await request(server)
      .post(CALLBACK)
      .send({
        custom_data: [{ keyof_customdata: 'transaction_id', valueof_customdata: 'x'.repeat(25) }],
      })
      .expect(200);
    const response = await checkout(standardYearly).expect(201);
    t.provider.pay('tok_1', 100);
    await callBack(response.body.paymentId);
    expect(t.db.rows('payment')[0]).toMatchObject({
      status: 'FAILED',
      duplicateReason: 'amount_mismatch',
    });
    expect(t.db.rows('subscription')).toHaveLength(0);
    // The exemption from the origin check is limited to the callback.
    await request(server)
      .post('/api/billing/checkout')
      .set(TEST_USER_HEADER, user.id as string)
      .send({ order: standardYearly, locale: 'fr' })
      .expect(403);
  });

  it('closes a refused payment and gives the reserved credit back', async () => {
    t.db.insert('creditEntry', { userId: user.id, amountXof: 500, reason: 'DUPLICATE_PAYMENT' });
    const response = await checkout(standardYearly).expect(201);
    expect(t.db.creditBalance(user.id as string)).toBe(0);
    t.provider.refuse('tok_1');
    await callBack(response.body.paymentId);
    expect(t.db.rows('payment')[0]!.status).toBe('FAILED');
    expect(t.db.creditBalance(user.id as string)).toBe(500);
  });

  it('gives the same LigdiCash page again for the same order still pending', async () => {
    const first = await checkout(standardYearly).expect(201);
    const second = await checkout(standardYearly).expect(201);
    expect(second.body).toEqual(first.body);
    expect(t.provider.invoices).toHaveLength(1);
  });

  it('fails cleanly when LigdiCash cannot create the invoice', async () => {
    t.provider.failNextInvoice = true;
    expect((await checkout(standardYearly)).body.code).toBe('payment_unavailable');
    expect(t.db.rows('payment')[0]).toMatchObject({
      status: 'FAILED',
      duplicateReason: 'not_sent',
    });
  });
});

describe('callback hardening (security review)', () => {
  it('activates from the form callback alone', async () => {
    const response = await checkout(standardYearly).expect(201);
    t.provider.pay('tok_1');
    await request(t.app.getHttpServer())
      .post(CALLBACK)
      .type('form')
      .send(
        `status=completed&custom_data[0][keyof_customdata]=transaction_id&custom_data[0][valueof_customdata]=${response.body.paymentId}`,
      )
      .expect(200);
    expect(t.db.rows('payment')[0]!.status).toBe('SUCCEEDED');
  });

  it('never activates when LigdiCash gives no amount', async () => {
    const response = await checkout(standardYearly).expect(201);
    t.provider.statuses.set('tok_1', {
      status: 'completed',
      amountXof: null,
      transactionId: 'LC-x',
      operator: null,
      raw: {},
    });
    await t.app.get(PaymentProcessor).check(response.body.paymentId);
    expect(t.db.rows('subscription')).toHaveLength(0);
    expect(t.db.rows('payment')[0]!.duplicateReason).toBe('amount_mismatch');
  });

  it('credits a payment refused once, then paid on the same LigdiCash page', async () => {
    const response = await checkout(standardYearly).expect(201);
    const processor = t.app.get(PaymentProcessor);
    t.provider.refuse('tok_1');
    await processor.check(response.body.paymentId);
    expect(t.db.rows('payment')[0]!.status).toBe('FAILED');
    t.provider.pay('tok_1');
    await processor.check(response.body.paymentId);
    expect(t.db.rows('payment')[0]).toMatchObject({
      status: 'CREDITED',
      duplicateReason: 'paid_after_not_completed',
    });
    expect(t.db.creditBalance(user.id as string)).toBe(20000);
  });

  it('only sends the payer to a LigdiCash page', () => {
    expect(isLigdicashPage('https://app.ligdicash.com/pay/invoice/x')).toBe(true);
    expect(isLigdicashPage('https://ligdicash.com.evil.test/pay')).toBe(false);
    expect(isLigdicashPage('http://app.ligdicash.com/pay')).toBe(false);
    expect(isLigdicashPage('javascript:alert(1)')).toBe(false);
  });

  it('caps the seats of one order', async () => {
    const order = {
      kind: 'NEW',
      plan: 'BUSINESS',
      period: 'YEARLY',
      seats: 5001,
      organization: { name: 'Grande école' },
    };
    expect((await quote(order)).body.code).toBe('invalid_seats');
  });
});

describe('duplicates, credit and minimum amount', () => {
  it('credits a payment made twice, tells the payer, and uses the credit next time', async () => {
    const first = await checkout(standardYearly).expect(201);
    // A second LigdiCash page for the same order (other device) before the first one is paid.
    t.db.rows('payment', { id: first.body.paymentId })[0]!.checkoutUrl = null;
    const second = await checkout(standardYearly).expect(201);
    expect(second.body.paymentId).not.toBe(first.body.paymentId);
    t.provider.pay('tok_1');
    t.provider.pay('tok_2');
    await callBack(first.body.paymentId);
    await callBack(second.body.paymentId);
    expect(t.db.rows('subscription')).toHaveLength(1);
    expect(t.db.rows('payment', { id: second.body.paymentId })[0]).toMatchObject({
      status: 'CREDITED',
      duplicateReason: 'already_subscribed',
    });
    expect(t.db.creditBalance(user.id as string)).toBe(20000);
    expect(t.db.rows('receipt')).toHaveLength(2);
    expect(t.db.rows('auditLog', { action: 'CREDIT_ADDED' })).toHaveLength(1);
    expect(t.db.rows('notification', { type: 'PAYMENT_CREDITED', userId: user.id })).toHaveLength(
      1,
    );
    const mail = t.outbox.mails.find((item) => item.subject.includes('double'))!;
    expect(mail.text).toContain('20 000 FCFA');
    expect(mail.text).toContain('facturation@integris.test');
    expect(mail.text).toContain('000002');
    const overview = await as(user).get('/billing').expect(200);
    expect(overview.body.creditBalance).toBe(20000);
    expect(overview.body.notices[0]).toMatchObject({ type: 'PAYMENT_CREDITED', amountXof: 20000 });
  });

  it('applies an order placed again after the first one ended (not a duplicate)', async () => {
    await pay(standardYearly);
    t.db.rows('subscription')[0]!.status = 'CANCELED';
    const again = await pay(standardYearly);
    expect(again.status).toBe('SUCCEEDED');
    expect(t.db.rows('subscription', { status: 'ACTIVE' })).toHaveLength(1);
    const team = {
      kind: 'NEW',
      plan: 'TEAM',
      period: 'MONTHLY',
      seats: 2,
      organization: { name: 'Labo' },
    };
    await pay(team);
    expect((await pay(team)).status).toBe('SUCCEEDED');
    expect(t.db.rows('organization')).toHaveLength(2);
  });

  it('credits the second of two payment pages open at once for one organization', async () => {
    const team = {
      kind: 'NEW',
      plan: 'TEAM',
      period: 'MONTHLY',
      seats: 2,
      organization: { name: 'Labo' },
    };
    const first = await checkout(team).expect(201);
    t.db.rows('payment', { id: first.body.paymentId })[0]!.checkoutUrl = null;
    const second = await checkout(team).expect(201);
    t.provider.pay('tok_1');
    t.provider.pay('tok_2');
    await callBack(first.body.paymentId);
    await callBack(second.body.paymentId);
    expect(t.db.rows('payment', { id: second.body.paymentId })[0]).toMatchObject({
      status: 'CREDITED',
      duplicateReason: 'same_order',
    });
    expect(t.db.rows('organization')).toHaveLength(1);
  });

  it('activates at once without LigdiCash when the credit covers the price', async () => {
    t.db.insert('creditEntry', { userId: user.id, amountXof: 25000, reason: 'DUPLICATE_PAYMENT' });
    const response = await checkout(standardYearly).expect(201);
    expect(response.body.redirectUrl).toBeNull();
    expect(t.provider.invoices).toHaveLength(0);
    expect(t.db.rows('payment')[0]).toMatchObject({
      status: 'SUCCEEDED',
      amountXof: 0,
      creditUsedXof: 20000,
    });
    expect(t.db.rows('subscription')[0]!.status).toBe('ACTIVE');
    expect(t.db.creditBalance(user.id as string)).toBe(5000);
    expect(t.db.rows('receipt')).toHaveLength(1);
    expect(t.db.rows('auditLog', { action: 'CREDIT_USED' })).toHaveLength(1);
  });

  it('charges the LigdiCash minimum and credits the difference', async () => {
    t.db.insert('creditEntry', { userId: user.id, amountXof: 19960, reason: 'DUPLICATE_PAYMENT' });
    const q = await quote(standardYearly).expect(200);
    expect(q.body).toMatchObject({
      creditUsed: 19960,
      minimumTopUp: 60,
      total: 100,
      minAmount: 100,
    });
    const payment = await pay(standardYearly);
    expect(payment).toMatchObject({ status: 'SUCCEEDED', amountXof: 100 });
    expect(t.db.creditBalance(user.id as string)).toBe(60);
    expect(t.db.rows('creditEntry', { reason: 'MIN_AMOUNT_TOPUP' })).toHaveLength(1);
  });
});

describe('promo codes', () => {
  it('applies to a new subscription, once per account', async () => {
    t.db.insert('promoCode', { code: 'RENTREE', percentOff: 25, maxRedemptions: 10 });
    const order = { ...standardYearly, promoCode: 'rentree' };
    expect((await quote(order)).body).toMatchObject({
      promo: 5000,
      total: 15000,
      promoPercent: 25,
    });
    await pay(order);
    expect(t.db.rows('promoCode')[0]!.redemptionCount).toBe(1);
    expect(t.db.rows('promoRedemption')).toHaveLength(1);
    const subscriptionId = t.db.rows('subscription')[0]!.id as string;
    expect(
      (
        await quote({
          kind: 'UPGRADE',
          subscriptionId,
          plan: 'STANDARD',
          period: 'YEARLY',
          seats: 1,
          promoCode: 'RENTREE',
        })
      ).status,
    ).toBe(409);
    const other = verifiedUser();
    t.db.rows('promoCode')[0]!.validUntil = new Date(Date.now() - 1000);
    expect((await quote(order, other)).body.code).toBe('promo_invalid');
    const renew = { kind: 'RENEW', subscriptionId, plan: 'STANDARD', period: 'YEARLY', seats: 1 };
    // No promo on a renewal: the field is not part of a renewal order.
    expect((await quote({ ...renew, promoCode: 'RENTREE' }).expect(200)).body).toMatchObject({
      promo: 0,
      total: 20000,
    });
  });
});

describe('trial', () => {
  it('is given once, ends without grace, and a payment starts at its end', async () => {
    expect((await as(user).get('/billing').expect(200)).body.trial).toMatchObject({
      available: true,
      days: 14,
      state: 'available',
      endsAt: null,
    });
    await as(user).post('/billing/trial').expect(204);
    const during = (await as(user).get('/billing').expect(200)).body.trial;
    expect(during).toMatchObject({ available: false, state: 'trialing' });
    expect(during.endsAt).toBe(
      (t.db.rows('subscription')[0]!.currentPeriodEnd as Date).toISOString(),
    );
    expect((await as(user).post('/billing/trial')).body.code).toBe('trial_unavailable');
    const [trial] = t.db.rows('subscription');
    expect(trial).toMatchObject({ status: 'TRIALING' });
    const end = trial!.currentPeriodEnd as Date;
    expect(Math.round((end.getTime() - Date.now()) / DAY_MS)).toBe(14);
    const monthly = { kind: 'NEW', plan: 'STANDARD', period: 'MONTHLY', seats: 1 };
    expect((await quote(monthly)).body.periodStart).toBe(end.toISOString());
    await pay(monthly);
    const [paid] = t.db.rows('subscription');
    expect(t.db.rows('subscription')).toHaveLength(1);
    expect(paid).toMatchObject({ status: 'ACTIVE', currentPeriodStart: end });
    expect(paid!.currentPeriodEnd).toEqual(addPeriod(end, 'MONTHLY'));
    const overview = await as(user).get('/billing').expect(200);
    expect(overview.body.trial).toMatchObject({ available: false, state: 'subscribed' });
  });

  it('tells why the trial is not offered: used, or after a paid STANDARD', async () => {
    const used = verifiedUser({ trialUsedAt: new Date() });
    expect((await as(used).get('/billing')).body.trial.state).toBe('used');
    await pay(standardYearly);
    t.db.rows('subscription')[0]!.status = 'EXPIRED';
    expect((await as(user).get('/billing')).body.trial.state).toBe('paid');
    expect((await as(user).post('/billing/trial')).body.code).toBe('trial_unavailable');
  });
});

describe('renewals, upgrades and seats', () => {
  const subscribe = (data: Record<string, unknown>) =>
    t.db.insert('subscription', {
      planId: 'STANDARD',
      userId: user.id,
      status: 'ACTIVE',
      billingPeriod: 'MONTHLY',
      currentPeriodStart: new Date(Date.now() - 20 * DAY_MS),
      currentPeriodEnd: new Date(Date.now() + 10 * DAY_MS),
      paidValueXof: 2000,
      paidFromAt: new Date(Date.now() - 20 * DAY_MS),
      ...data,
    });

  it('renews from the old period end, even during the grace', async () => {
    const oldEnd = new Date(Date.now() - 2 * DAY_MS);
    const subscription = subscribe({
      status: 'GRACE',
      currentPeriodEnd: oldEnd,
      graceEndsAt: new Date(oldEnd.getTime() + 7 * DAY_MS),
    });
    await pay({
      kind: 'RENEW',
      subscriptionId: subscription.id,
      plan: 'STANDARD',
      period: 'MONTHLY',
      seats: 1,
    });
    expect(subscription).toMatchObject({
      status: 'ACTIVE',
      graceEndsAt: null,
      currentPeriodStart: oldEnd,
    });
    expect(subscription.currentPeriodEnd).toEqual(addPeriod(oldEnd, 'MONTHLY'));
  });

  it('credits a renewal paid twice for the same period', async () => {
    const subscription = subscribe({});
    const renew = {
      kind: 'RENEW',
      subscriptionId: subscription.id,
      plan: 'STANDARD',
      period: 'MONTHLY',
      seats: 1,
    };
    const first = await checkout(renew).expect(201);
    t.db.rows('payment', { id: first.body.paymentId })[0]!.checkoutUrl = null;
    const second = await checkout(renew).expect(201);
    t.provider.pay('tok_1');
    t.provider.pay('tok_2');
    await callBack(first.body.paymentId);
    await callBack(second.body.paymentId);
    expect(t.db.rows('payment', { id: second.body.paymentId })[0]!.status).toBe('CREDITED');
    expect(t.db.creditBalance(user.id as string)).toBe(2000);
  });

  it('upgrades to yearly at once, deducting the days left', async () => {
    const subscription = subscribe({});
    const upgrade = {
      kind: 'UPGRADE',
      subscriptionId: subscription.id,
      plan: 'STANDARD',
      period: 'YEARLY',
      seats: 1,
    };
    const q = (await quote(upgrade).expect(200)).body;
    // 2 000 paid for 30 days, 10 days left: 667 deducted.
    expect(q).toMatchObject({ prorationCredit: 667, total: 19333 });
    await pay(upgrade);
    expect(subscription).toMatchObject({ billingPeriod: 'YEARLY', paidValueXof: 20000 });
    const downgrade = { ...upgrade, period: 'MONTHLY' };
    expect((await quote(downgrade)).body.code).toBe('not_an_upgrade');
  });

  it('applies a lower renewal at the period end', async () => {
    const subscription = subscribe({ billingPeriod: 'YEARLY' });
    await pay({
      kind: 'RENEW',
      subscriptionId: subscription.id,
      plan: 'STANDARD',
      period: 'MONTHLY',
      seats: 1,
    });
    expect(subscription).toMatchObject({
      billingPeriod: 'YEARLY',
      pendingBillingPeriod: 'MONTHLY',
      pendingValueXof: 2000,
    });
    const end = subscription.currentPeriodEnd as Date;
    await t.app.get(BillingScheduler).applyPendingChanges(new Date(end.getTime() + 1000));
    expect(subscription).toMatchObject({
      billingPeriod: 'MONTHLY',
      pendingPlanId: null,
      currentPeriodStart: end,
    });
  });

  it('creates a BUSINESS with its owner seat, then adds prorated seats', async () => {
    const order = {
      kind: 'NEW',
      plan: 'BUSINESS',
      period: 'MONTHLY',
      seats: 10,
      organization: { name: 'Université pilote', ifu: '00012345A' },
    };
    await pay(order);
    const [organization] = t.db.rows('organization');
    expect(organization).toMatchObject({
      type: 'BUSINESS',
      name: 'Université pilote',
      ifu: '00012345A',
    });
    expect(t.db.rows('membership')[0]).toMatchObject({ role: 'OWNER', userId: user.id });
    const [subscription] = t.db.rows('subscription');
    expect(t.db.rows('seat', { subscriptionId: subscription!.id })).toHaveLength(10);
    expect(t.db.rows('seat', { userId: user.id })).toHaveLength(1);
    expect(t.db.rows('auditLog', { action: 'SEAT_ASSIGNED' })).toHaveLength(1);
    const seats = await quote({ kind: 'SEATS', subscriptionId: subscription!.id, seats: 5 }).expect(
      200,
    );
    expect(seats.body.total).toBeLessThanOrEqual(10000);
    expect(seats.body.total).toBeGreaterThan(9000);
    await pay({ kind: 'SEATS', subscriptionId: subscription!.id, seats: 5 });
    expect(subscription!.seatCount).toBe(15);
    // Only the owner pays for and changes the organization.
    const stranger = verifiedUser();
    expect(
      (await quote({ kind: 'SEATS', subscriptionId: subscription!.id, seats: 1 }, stranger)).body
        .code,
    ).toBe('subscription_not_found');
    expect(t.db.rows('receipt')[1]!.billedTo).toMatchObject({ organization: 'Université pilote' });
  });

  it('pauses a paid STANDARD while its holder occupies a TEAM seat', async () => {
    const standard = subscribe({});
    await pay({
      kind: 'NEW',
      plan: 'TEAM',
      period: 'MONTHLY',
      seats: 2,
      organization: { name: 'Équipe' },
    });
    expect(standard).toMatchObject({ status: 'PAUSED', pausedRemainingDays: 10 });
    expect(
      (
        await quote({
          kind: 'RENEW',
          subscriptionId: standard.id,
          plan: 'STANDARD',
          period: 'MONTHLY',
          seats: 1,
        })
      ).body.code,
    ).toBe('subscription_paused');
    // The TEAM ends: the STANDARD resumes with its days left.
    const team = t.db.rows('subscription', { planId: 'TEAM' })[0]!;
    team.status = 'EXPIRED';
    await t.app.get(BillingScheduler).syncPauses(new Date());
    expect(standard.status).toBe('ACTIVE');
    expect(Math.round(((standard.currentPeriodEnd as Date).getTime() - Date.now()) / DAY_MS)).toBe(
      10,
    );
  });
});

describe('scheduler', () => {
  it('sends each renewal reminder once, with a direct link, then starts the grace', async () => {
    const subscription = t.db.insert('subscription', {
      planId: 'STANDARD',
      userId: user.id,
      status: 'ACTIVE',
      billingPeriod: 'MONTHLY',
      currentPeriodStart: new Date(Date.now() - 26 * DAY_MS),
      currentPeriodEnd: new Date(Date.now() + 4 * DAY_MS),
    });
    const scheduler = t.app.get(BillingScheduler);
    await scheduler.renewalReminders(new Date());
    await scheduler.renewalReminders(new Date());
    await flushNotifications();
    expect(t.outbox.sms).toHaveLength(1);
    expect(t.outbox.sms[0]!.text).toContain(`/fr/app/billing/checkout?renew=${subscription.id}`);
    await scheduler.renewalReminders(new Date(Date.now() + 3.5 * DAY_MS));
    await flushNotifications();
    expect(t.outbox.sms).toHaveLength(2);

    await scheduler.startGrace(new Date(Date.now() + 5 * DAY_MS));
    expect(subscription.status).toBe('GRACE');
    expect(subscription.graceEndsAt).toEqual(
      new Date((subscription.currentPeriodEnd as Date).getTime() + 7 * DAY_MS),
    );
    expect(t.db.rows('notification', { type: 'GRACE_STARTED', channel: 'IN_APP' })).toHaveLength(1);
  });

  it('reminds of the trial end 3 days before', async () => {
    await as(user).post('/billing/trial').expect(204);
    const scheduler = t.app.get(BillingScheduler);
    await scheduler.trialReminders(new Date(Date.now() + 10 * DAY_MS));
    expect(t.outbox.sms).toHaveLength(0);
    await scheduler.trialReminders(new Date(Date.now() + 12 * DAY_MS));
    await scheduler.trialReminders(new Date(Date.now() + 12.5 * DAY_MS));
    await flushNotifications();
    expect(t.outbox.sms).toHaveLength(1);
    expect(t.outbox.sms[0]!.text).toContain('essai Standard');
  });

  it('closes a payment still pending after the limit and credits it if paid later', async () => {
    t.db.insert('creditEntry', { userId: user.id, amountXof: 300, reason: 'DUPLICATE_PAYMENT' });
    const response = await checkout(standardYearly).expect(201);
    const processor = t.app.get(PaymentProcessor);
    await processor.sweepPending(new Date(Date.now() + 25 * 3600_000));
    expect(t.db.rows('payment')[0]).toMatchObject({ status: 'FAILED', duplicateReason: 'expired' });
    expect(t.db.creditBalance(user.id as string)).toBe(300);
    t.provider.pay('tok_1');
    await callBack(response.body.paymentId);
    expect(t.db.rows('payment')[0]).toMatchObject({
      status: 'CREDITED',
      duplicateReason: 'paid_after_expired',
    });
    expect(t.db.rows('subscription')).toHaveLength(0);
    expect(t.db.creditBalance(user.id as string)).toBe(300 + 19700);
  });
});

describe('receipts', () => {
  it('are numbered without gaps and sent again on request', async () => {
    await pay(standardYearly);
    const other = verifiedUser();
    await pay(standardYearly, other);
    expect(t.db.rows('receipt').map((row) => row.number)).toEqual([1, 2]);
    const paymentId = t.db.rows('payment', { userId: other.id })[0]!.id as string;
    expect((await as(user).post(`/billing/payments/${paymentId}/receipt`)).status).toBe(404);
    await as(other).post(`/billing/payments/${paymentId}/receipt`).expect(204);
    expect(t.outbox.mails.filter((mail) => mail.subject.includes('000002'))).toHaveLength(2);
  });
});

describe('paymentIdOf', () => {
  it('reads our id from the JSON or form shapes of LigdiCash', () => {
    const id = 'c'.repeat(25);
    expect(
      paymentIdOf({
        custom_data: [
          { keyof_customdata: 'hash', valueof_customdata: 'zzzzzzzzzzzzzzzzzzzzzzzz' },
          { keyof_customdata: 'transaction_id', valueof_customdata: id },
        ],
      }),
    ).toBe(id);
    expect(
      paymentIdOf({
        'custom_data[1][keyof_customdata]': 'transaction_id',
        'custom_data[1][valueof_customdata]': id,
      }),
    ).toBe(id);
    expect(paymentIdOf({ external_id: id })).toBe(id);
    expect(paymentIdOf({ external_id: '../../etc' })).toBeNull();
  });
});
