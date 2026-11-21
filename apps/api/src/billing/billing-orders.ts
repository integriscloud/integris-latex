import type {
  BillingPeriod,
  Organization,
  PaymentPurpose,
  Plan,
  Prisma,
  PromoCode,
  Subscription,
} from '@integris/db';
import {
  addPeriod,
  type BillingOrder,
  type BillingQuote,
  isOrganizationPlan,
  type PaidPlanCode,
  planRank,
  type Quote,
  quotePrice,
  seatsAllowed,
} from '@integris/shared';
import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';

type Db = Prisma.TransactionClient;

export type OrderSubscription = Subscription & { plan: Plan; organization: Organization | null };

/** State of the subscription an order was priced on: a payment applies only to that state. */
export interface ExpectedState {
  planCode: string;
  period: BillingPeriod;
  seats: number;
  periodEnd: string;
  pending: boolean;
}

/** What a payment bought, stored in `Payment.order` (with the price lines in `breakdown`). */
export interface StoredOrder {
  kind: BillingOrder['kind'];
  planCode: Plan['code'];
  period: BillingPeriod;
  /** Seats of the subscription; for SEATS, the seats added. */
  seats: number;
  subscriptionId: string | null;
  organization: { name: string; ifu?: string } | null;
  promoCode: string | null;
  expected: ExpectedState | null;
  /** Identical orders are recognized by it (reuse of a pending payment, duplicates). */
  fingerprint: string;
  /** Value of the period bought (after promo), kept on the subscription for proration. */
  value: number;
  minimumTopUp: number;
  prorationSurplus: number;
}

export interface PreparedOrder {
  stored: StoredOrder;
  plan: Plan;
  subscription: OrderSubscription | null;
  /** STANDARD trial converted by this order (the paid period starts at its end). */
  trial: Subscription | null;
  promo: PromoCode | null;
  creditBalance: number;
  quote: Quote;
  periodStart: Date;
  periodEnd: Date;
}

export const PURPOSES: Record<BillingOrder['kind'], PaymentPurpose> = {
  NEW: 'NEW_SUBSCRIPTION',
  RENEW: 'RENEWAL',
  UPGRADE: 'UPGRADE',
  SEATS: 'EXTRA_SEATS',
};

/** Credit balance of a payer: the sum of their ledger. */
export async function creditBalanceOf(db: Db, userId: string): Promise<number> {
  const sum = await db.creditEntry.aggregate({ where: { userId }, _sum: { amountXof: true } });
  return Math.max(0, sum._sum.amountXof ?? 0);
}

/** Seats of a subscription held by someone or reserved by a pending invitation (step 12). */
export function seatsUsedOf(db: Db, subscriptionId: string): Promise<number> {
  return db.seat.count({
    where: {
      subscriptionId,
      OR: [{ userId: { not: null }, releasedAt: null }, { invitationId: { not: null } }],
    },
  });
}

/** Subscription paid by the user: their personal one, or one of an organization they own. */
export async function payerSubscription(
  db: Db,
  userId: string,
  subscriptionId: string,
): Promise<OrderSubscription> {
  const subscription = await db.subscription.findUnique({
    where: { id: subscriptionId },
    include: { plan: true, organization: true },
  });
  if (!subscription) throw new ApiError(HttpStatus.NOT_FOUND, 'subscription_not_found');
  if (subscription.userId === userId) return subscription;
  if (subscription.organizationId) {
    const owner = await db.membership.findFirst({
      where: {
        organizationId: subscription.organizationId,
        userId,
        role: 'OWNER',
        status: 'ACTIVE',
      },
    });
    if (owner) return subscription;
  }
  throw new ApiError(HttpStatus.NOT_FOUND, 'subscription_not_found');
}

/** The payer of a subscription: its personal holder, or the owner of its organization. */
export async function payerOf(db: Db, subscription: Subscription): Promise<string | null> {
  if (subscription.userId) return subscription.userId;
  if (!subscription.organizationId) return null;
  const owner = await db.membership.findFirst({
    where: { organizationId: subscription.organizationId, role: 'OWNER', status: 'ACTIVE' },
  });
  return owner?.userId ?? null;
}

export function expectedState(subscription: Subscription & { plan: Plan }): ExpectedState {
  return {
    planCode: subscription.plan.code,
    period: subscription.billingPeriod,
    seats: subscription.seatCount,
    periodEnd: subscription.currentPeriodEnd.toISOString(),
    pending: subscription.pendingPlanId !== null,
  };
}

export function sameState(a: ExpectedState, b: ExpectedState): boolean {
  return (
    a.planCode === b.planCode &&
    a.period === b.period &&
    a.seats === b.seats &&
    a.periodEnd === b.periodEnd &&
    a.pending === b.pending
  );
}

async function activePlan(db: Db, code: Plan['code']): Promise<Plan> {
  const plan = await db.plan.findUnique({ where: { code } });
  if (!plan || !plan.isActive || code === 'FREE') {
    throw new ApiError(HttpStatus.CONFLICT, 'plan_unavailable');
  }
  return plan;
}

/** A promo code usable by this user on this order (NEW and UPGRADE only, once per account). */
async function usablePromo(
  db: Db,
  userId: string,
  code: string,
  plan: Plan,
  now: Date,
): Promise<PromoCode> {
  const promo = await db.promoCode.findUnique({ where: { code } });
  if (
    !promo ||
    !promo.isActive ||
    (promo.validUntil !== null && promo.validUntil <= now) ||
    (promo.maxRedemptions !== null && promo.redemptionCount >= promo.maxRedemptions)
  ) {
    throw new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, 'promo_invalid');
  }
  if (promo.planCodes.length > 0 && !promo.planCodes.includes(plan.code)) {
    throw new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, 'promo_not_applicable');
  }
  const used = await db.promoRedemption.findFirst({ where: { promoCodeId: promo.id, userId } });
  if (used) throw new ApiError(HttpStatus.CONFLICT, 'promo_already_used');
  return promo;
}

/**
 * Checks an order against the rules of step 11 and prices it from the `Plan` table. Nothing is
 * written. Called for the quote shown while choosing, and again, inside the payer's lock, when
 * the payment is created.
 */
export async function prepareOrder(
  db: Db,
  userId: string,
  order: BillingOrder,
  options: { now: Date; minAmount: number; maxSeats: number },
): Promise<PreparedOrder> {
  const { now, minAmount, maxSeats } = options;
  const totalSeats = order.kind === 'SEATS' ? order.seats : 'seats' in order ? order.seats : 1;
  if (totalSeats > maxSeats) throw new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, 'invalid_seats');
  let subscription: OrderSubscription | null = null;
  let trial: Subscription | null = null;
  let plan: Plan;
  let period: BillingPeriod;
  let seats: number;
  let periodStart = now;
  let periodEnd: Date;

  if (order.kind === 'NEW') {
    plan = await activePlan(db, order.plan);
    period = order.period;
    seats = order.seats;
    if (!seatsAllowed(plan, seats))
      throw new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, 'invalid_seats');
    if (isOrganizationPlan(plan.code)) {
      if (!order.organization) {
        throw new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, 'organization_required');
      }
    } else {
      const personal = await db.subscription.findMany({
        where: { userId, status: { in: ['TRIALING', 'ACTIVE', 'GRACE', 'PAUSED'] } },
      });
      if (personal.some((row) => row.status !== 'TRIALING')) {
        throw new ApiError(HttpStatus.CONFLICT, 'already_subscribed');
      }
      // Paid during the trial: the paid period starts at its end (step 11 decision).
      trial = personal.find((row) => row.currentPeriodEnd > now) ?? null;
      if (trial) periodStart = trial.currentPeriodEnd;
    }
    periodEnd = addPeriod(periodStart, period);
  } else {
    subscription = await payerSubscription(db, userId, order.subscriptionId);
    const current = subscription;
    if (current.status === 'PAUSED') throw new ApiError(HttpStatus.CONFLICT, 'subscription_paused');
    if (current.status === 'CANCELED' || current.status === 'TRIALING') {
      throw new ApiError(HttpStatus.CONFLICT, 'subscription_not_found');
    }
    const used = await seatsUsedOf(db, current.id);
    const organization = current.organizationId !== null;
    if (order.kind === 'SEATS') {
      if (!organization || current.status !== 'ACTIVE' || current.currentPeriodEnd <= now) {
        throw new ApiError(HttpStatus.CONFLICT, 'plan_unavailable');
      }
      plan = current.plan;
      period = current.billingPeriod;
      seats = order.seats;
      if (!seatsAllowed(plan, current.seatCount + seats) || current.seatCount + seats > maxSeats) {
        throw new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, 'invalid_seats');
      }
      periodEnd = current.currentPeriodEnd;
    } else {
      plan = await activePlan(db, order.plan);
      period = order.period;
      seats = order.seats;
      // The scope never changes: a personal STANDARD stays personal (a TEAM or BUSINESS seat
      // pauses it instead), an organization stays on an organization plan.
      if (isOrganizationPlan(plan.code) !== organization) {
        throw new ApiError(HttpStatus.CONFLICT, 'plan_unavailable');
      }
      if (!seatsAllowed(plan, seats))
        throw new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, 'invalid_seats');
      if (seats < used) throw new ApiError(HttpStatus.CONFLICT, 'seats_in_use');
      if (current.pendingPlanId !== null)
        throw new ApiError(HttpStatus.CONFLICT, 'renewal_pending');
      const higher = planRank(plan.code) > planRank(current.plan.code);
      if (order.kind === 'UPGRADE') {
        const longer =
          plan.code === current.plan.code &&
          current.billingPeriod === 'MONTHLY' &&
          period === 'YEARLY';
        if (!higher && !longer) throw new ApiError(HttpStatus.CONFLICT, 'not_an_upgrade');
        if (current.status === 'EXPIRED')
          throw new ApiError(HttpStatus.CONFLICT, 'plan_unavailable');
        periodEnd = addPeriod(now, period);
      } else {
        // A renewal keeps or lowers the plan; a higher plan is an upgrade (immediate).
        if (higher) throw new ApiError(HttpStatus.CONFLICT, 'plan_unavailable');
        // Renewed in grace: from the old period end; after the return to Free: from now.
        periodStart = current.status === 'EXPIRED' ? now : current.currentPeriodEnd;
        periodEnd = addPeriod(periodStart, period);
      }
    }
  }

  const promoCode = 'promoCode' in order ? (order.promoCode ?? null) : null;
  const promo = promoCode ? await usablePromo(db, userId, promoCode, plan, now) : null;
  const creditBalance = await creditBalanceOf(db, userId);
  const quote = quotePrice({
    kind: order.kind,
    plan,
    period,
    seats,
    now,
    current: subscription
      ? {
          periodEnd: subscription.currentPeriodEnd,
          period: subscription.billingPeriod,
          paidValueXof: subscription.paidValueXof,
          paidFrom: subscription.paidFromAt,
        }
      : undefined,
    promoPercent: promo?.percentOff ?? null,
    creditBalance,
    minAmount,
  });
  // Amounts are int4 columns: never anything near their limit (2^31 − 1).
  if (quote.base > 1_000_000_000)
    throw new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, 'invalid_seats');
  const expected = subscription ? expectedState(subscription) : null;
  const organization = order.kind === 'NEW' ? (order.organization ?? null) : null;
  const fingerprint = JSON.stringify([
    order.kind,
    plan.code,
    period,
    seats,
    subscription?.id ?? null,
    organization?.name.toLowerCase() ?? null,
    promoCode,
    expected,
  ]);
  return {
    stored: {
      kind: order.kind,
      planCode: plan.code,
      period,
      seats,
      subscriptionId: subscription?.id ?? null,
      organization: organization ? { name: organization.name, ifu: organization.ifu } : null,
      promoCode,
      expected,
      fingerprint,
      value: quote.value,
      minimumTopUp: quote.minimumTopUp,
      prorationSurplus: quote.prorationSurplus,
    },
    plan,
    subscription,
    trial,
    promo,
    creditBalance,
    quote,
    periodStart,
    periodEnd,
  };
}

export function quoteView(prepared: PreparedOrder, minAmount: number, emailRequired: boolean) {
  const { quote, stored } = prepared;
  return {
    planCode: stored.planCode as PaidPlanCode,
    period: stored.period,
    seats: stored.seats,
    base: quote.base,
    volumeDiscount: quote.volumeDiscount,
    promo: quote.promo,
    promoPercent: prepared.promo?.percentOff ?? null,
    prorationCredit: quote.prorationCredit,
    subtotal: quote.subtotal,
    prorationSurplus: quote.prorationSurplus,
    creditUsed: quote.creditUsed,
    minimumTopUp: quote.minimumTopUp,
    total: quote.total,
    creditBalance: prepared.creditBalance,
    minAmount,
    periodStart: prepared.periodStart.toISOString(),
    periodEnd: prepared.periodEnd.toISOString(),
    emailRequired,
  } satisfies BillingQuote;
}
