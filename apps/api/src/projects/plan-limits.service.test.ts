import { describe, expect, it } from 'vitest';
import { planWritable } from './plan-limits.service.js';
import { isSubscriptionLive, subscriptionLiveUntil } from './quota.service.js';

const DAY_MS = 86_400_000;
const project = (id: string, readOnly = false) => ({
  id,
  readOnlyReason: readOnly ? 'OVER_PLAN_LIMIT' : null,
});

describe('planWritable (projects most recently active first)', () => {
  it('keeps the most recent projects writable on the way down to the limit', () => {
    expect(
      planWritable(
        ['a', 'b', 'c', 'd', 'e'].map((id) => project(id)),
        3,
      ),
    ).toEqual({
      toReadOnly: ['d', 'e'],
      toWritable: [],
    });
  });

  it('keeps the current choice and gives a free place to the most recent read-only project', () => {
    const projects = [project('a', true), project('b'), project('c', true), project('d')];
    expect(planWritable(projects, 3)).toEqual({ toReadOnly: [], toWritable: ['a'] });
    expect(planWritable(projects, 2)).toEqual({ toReadOnly: [], toWritable: [] });
  });

  it('makes everything writable without limit, and never touches other reasons', () => {
    const projects = [project('a', true), { id: 'b', readOnlyReason: 'OTHER' }, project('c')];
    expect(planWritable(projects, null)).toEqual({ toReadOnly: [], toWritable: ['a'] });
  });
});

describe('subscription dates', () => {
  const now = new Date('2026-11-20T12:00:00Z');
  const end = (days: number) => new Date(now.getTime() + days * DAY_MS);

  it('applies a plan until its grace end, else 7 days after its period', () => {
    expect(
      subscriptionLiveUntil({ status: 'ACTIVE', currentPeriodEnd: end(0), graceEndsAt: null }),
    ).toEqual(end(7));
    expect(
      subscriptionLiveUntil({ status: 'GRACE', currentPeriodEnd: end(-2), graceEndsAt: end(3) }),
    ).toEqual(end(3));
    expect(
      isSubscriptionLive({ status: 'ACTIVE', currentPeriodEnd: end(-6), graceEndsAt: null }, now),
    ).toBe(true);
    expect(
      isSubscriptionLive({ status: 'ACTIVE', currentPeriodEnd: end(-8), graceEndsAt: null }, now),
    ).toBe(false);
  });

  it('ends a trial with its period, without grace (step 11 decision)', () => {
    expect(
      subscriptionLiveUntil({ status: 'TRIALING', currentPeriodEnd: end(2), graceEndsAt: null }),
    ).toEqual(end(2));
    expect(
      isSubscriptionLive({ status: 'TRIALING', currentPeriodEnd: end(-1), graceEndsAt: null }, now),
    ).toBe(false);
  });

  it('never applies a paused, expired or canceled subscription', () => {
    for (const status of ['PAUSED', 'EXPIRED', 'CANCELED'] as const) {
      expect(
        isSubscriptionLive({ status, currentPeriodEnd: end(30), graceEndsAt: null }, now),
      ).toBe(false);
    }
  });
});
