import { describe, expect, it } from 'vitest';
import {
  addPeriod,
  billingOrderSchema,
  daysBetween,
  type PricingPlan,
  quotePrice,
  remainingValue,
  seatsAllowed,
} from './billing.js';

const standard: PricingPlan = {
  code: 'STANDARD',
  priceMonthlyXof: 2000,
  priceYearlyXof: 20000,
  minSeats: 1,
  maxSeats: 1,
};
const team: PricingPlan = {
  code: 'TEAM',
  priceMonthlyXof: 2500,
  priceYearlyXof: 25000,
  minSeats: 2,
  maxSeats: 10,
};
const business: PricingPlan = {
  code: 'BUSINESS',
  priceMonthlyXof: 2000,
  priceYearlyXof: 20000,
  minSeats: 10,
  maxSeats: null,
};
const now = new Date('2026-11-21T10:00:00Z');
const base = { now, creditBalance: 0, minAmount: 100 };

describe('billing periods', () => {
  it('adds calendar months and years in UTC, clamping the day', () => {
    expect(addPeriod(new Date('2026-01-31T08:00:00Z'), 'MONTHLY')).toEqual(
      new Date('2026-02-28T08:00:00Z'),
    );
    expect(addPeriod(new Date('2028-01-31T08:00:00Z'), 'MONTHLY')).toEqual(
      new Date('2028-02-29T08:00:00Z'),
    );
    expect(addPeriod(new Date('2026-11-21T10:00:00Z'), 'YEARLY')).toEqual(
      new Date('2027-11-21T10:00:00Z'),
    );
    expect(addPeriod(new Date('2027-01-15T00:00:00Z'), 'MONTHLY', -1)).toEqual(
      new Date('2026-12-15T00:00:00Z'),
    );
  });

  it('counts a started day as a day', () => {
    expect(daysBetween(now, new Date('2026-11-22T10:00:00Z'))).toBe(1);
    expect(daysBetween(now, new Date('2026-11-22T10:00:01Z'))).toBe(2);
    expect(daysBetween(now, new Date('2026-11-20T10:00:00Z'))).toBe(0);
  });

  it('checks the seats of each plan', () => {
    expect(seatsAllowed(standard, 1)).toBe(true);
    expect(seatsAllowed(standard, 2)).toBe(false);
    expect(seatsAllowed(team, 1)).toBe(false);
    expect(seatsAllowed(team, 10)).toBe(true);
    expect(seatsAllowed(team, 11)).toBe(false);
    expect(seatsAllowed(business, 9)).toBe(false);
    expect(seatsAllowed(business, 5000)).toBe(true);
  });
});

describe('quotePrice', () => {
  it('prices a new subscription per seat and period from the plan', () => {
    expect(
      quotePrice({ ...base, kind: 'NEW', plan: standard, period: 'YEARLY', seats: 1 }),
    ).toMatchObject({ base: 20000, promo: 0, total: 20000, value: 20000 });
    expect(
      quotePrice({ ...base, kind: 'NEW', plan: team, period: 'MONTHLY', seats: 4 }).total,
    ).toBe(10000);
    expect(
      quotePrice({ ...base, kind: 'NEW', plan: business, period: 'YEARLY', seats: 150 }),
    ).toMatchObject({ base: 3_000_000, volumeDiscount: 0, total: 3_000_000 });
  });

  it('applies a promo code to new subscriptions and upgrades only, rounded for the customer', () => {
    const order = {
      ...base,
      plan: standard,
      period: 'MONTHLY' as const,
      seats: 1,
      promoPercent: 15,
    };
    expect(quotePrice({ ...order, kind: 'NEW' })).toMatchObject({ promo: 300, total: 1700 });
    expect(quotePrice({ ...order, kind: 'RENEW' })).toMatchObject({ promo: 0, total: 2000 });
    // 1 999 × 15 % = 299.85: the discount is rounded up, in favour of the customer.
    const odd = { ...standard, priceMonthlyXof: 1999 };
    expect(quotePrice({ ...order, plan: odd, kind: 'NEW' })).toMatchObject({
      promo: 300,
      total: 1699,
    });
    expect(quotePrice({ ...order, kind: 'NEW', promoPercent: 100 })).toMatchObject({
      promo: 2000,
      total: 0,
    });
  });

  it('prorates extra seats until the period end, rounded down', () => {
    // Monthly period of 30 days (21 Nov → 21 Dec), 10 days left: 2 500 × 3 × 10 / 30 = 2 500.
    const current = {
      periodEnd: new Date('2026-12-01T10:00:00Z'),
      period: 'MONTHLY' as const,
      paidValueXof: 5000,
      paidFrom: new Date('2026-11-01T10:00:00Z'),
    };
    expect(
      quotePrice({ ...base, kind: 'SEATS', plan: team, period: 'MONTHLY', seats: 3, current }),
    ).toMatchObject({ base: 2500, total: 2500 });
    // 31-day period, 10 days left: 2 500 × 1 × 10 / 31 = 806.45… → 806.
    const longer = { ...current, periodEnd: new Date('2027-01-01T10:00:00Z') };
    const at = new Date('2026-12-22T10:00:00Z');
    expect(
      quotePrice({
        ...base,
        now: at,
        kind: 'SEATS',
        plan: team,
        period: 'MONTHLY',
        seats: 1,
        current: longer,
      }).base,
    ).toBe(806);
  });

  it('deducts the remaining paid value on an upgrade, rounded up, the rest to the credit', () => {
    // Paid 2 000 for 30 days, 10 days left: 666.67 → 667.
    const current = {
      periodEnd: new Date('2026-12-01T10:00:00Z'),
      period: 'MONTHLY' as const,
      paidValueXof: 2000,
      paidFrom: new Date('2026-11-01T10:00:00Z'),
    };
    expect(remainingValue(current, now)).toBe(667);
    expect(
      quotePrice({ ...base, kind: 'UPGRADE', plan: standard, period: 'YEARLY', seats: 1, current }),
    ).toMatchObject({ prorationCredit: 667, subtotal: 19333, prorationSurplus: 0, total: 19333 });
    // A trial or a plan given by a tool has no paid value.
    expect(remainingValue({ ...current, paidValueXof: 0 }, now)).toBe(0);
    expect(remainingValue({ ...current, paidFrom: null }, now)).toBe(0);
    // Team → Business can cost less than the credit left: the surplus goes to the credit balance.
    const yearlyTeam = {
      periodEnd: new Date('2027-11-01T10:00:00Z'),
      period: 'YEARLY' as const,
      paidValueXof: 250_000,
      paidFrom: new Date('2026-11-01T10:00:00Z'),
    };
    const upgrade = quotePrice({
      ...base,
      kind: 'UPGRADE',
      plan: business,
      period: 'MONTHLY',
      seats: 10,
      current: yearlyTeam,
    });
    expect(upgrade.subtotal).toBe(0);
    expect(upgrade.total).toBe(0);
    expect(upgrade.prorationSurplus).toBe(upgrade.prorationCredit - 20000);
  });

  it('uses the credit balance first and never charges less than the LigdiCash minimum', () => {
    const order = {
      ...base,
      kind: 'NEW' as const,
      plan: standard,
      period: 'MONTHLY' as const,
      seats: 1,
    };
    expect(quotePrice({ ...order, creditBalance: 500 })).toMatchObject({
      creditUsed: 500,
      minimumTopUp: 0,
      total: 1500,
    });
    expect(quotePrice({ ...order, creditBalance: 5000 })).toMatchObject({
      creditUsed: 2000,
      total: 0,
    });
    // 40 FCFA left: the minimum (100) is paid and 60 FCFA go to the credit balance.
    expect(quotePrice({ ...order, creditBalance: 1960 })).toMatchObject({
      creditUsed: 1960,
      minimumTopUp: 60,
      total: 100,
    });
    expect(quotePrice({ ...order, creditBalance: 1900 })).toMatchObject({
      minimumTopUp: 0,
      total: 100,
    });
  });
});

describe('billingOrderSchema', () => {
  it('normalizes promo codes and the optional IFU', () => {
    const order = billingOrderSchema.parse({
      kind: 'NEW',
      plan: 'BUSINESS',
      period: 'YEARLY',
      seats: 10,
      organization: { name: ' Université pilote ', ifu: '' },
      promoCode: ' rentree26 ',
    });
    expect(order).toMatchObject({
      promoCode: 'RENTREE26',
      organization: { name: 'Université pilote', ifu: undefined },
    });
    expect(() =>
      billingOrderSchema.parse({ kind: 'NEW', plan: 'FREE', period: 'YEARLY', seats: 1 }),
    ).toThrow();
  });
});
