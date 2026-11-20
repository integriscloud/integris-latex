import { z } from 'zod';
import { PLAN_CODES, type PlanCodeValue } from './plans.js';

// Prices, proration and payments (docs/spec.md, "Paiement et facturation", decisions of step 11).
// Every amount is an integer number of XOF (FCFA), TTC. The API computes every price from the
// `Plan` table with these functions; the web app only displays the quotes the API returns.

export const BILLING_PERIODS = ['MONTHLY', 'YEARLY'] as const;
export type BillingPeriodValue = (typeof BILLING_PERIODS)[number];

/** Plans that can be paid for (FREE is the default plan). */
export const PAID_PLAN_CODES = ['STANDARD', 'TEAM', 'BUSINESS'] as const;
export type PaidPlanCode = (typeof PAID_PLAN_CODES)[number];

/** Plans paid by an organization (one seat per member, the owner included). */
export const ORGANIZATION_PLAN_CODES = ['TEAM', 'BUSINESS'] as const;

export function isOrganizationPlan(code: PlanCodeValue): boolean {
  return (ORGANIZATION_PLAN_CODES as readonly string[]).includes(code);
}

/** Rank of a plan: a higher rank is a higher plan ("plan supérieur"). */
export function planRank(code: PlanCodeValue): number {
  return PLAN_CODES.indexOf(code);
}

/** Smallest amount LigdiCash accepts for one transaction by default (LIGDICASH_MIN_AMOUNT). */
export const DEFAULT_LIGDICASH_MIN_AMOUNT = 100;

/** Renewal reminders, days before the end of the paid period (docs/spec.md, "Renouvellement"). */
export const RENEWAL_REMINDER_DAYS = [5, 1] as const;
/** Reminder before the end of a trial, and before the end of the grace period (to members). */
export const TRIAL_REMINDER_DAYS = 3;
export const GRACE_REMINDER_DAYS = 3;

const DAY_MS = 86_400_000;

/**
 * End of `count` billing periods from `start`: calendar months or years in UTC, the day clamped
 * to the end of a shorter month (31 January + 1 month = 28 or 29 February).
 */
export function addPeriod(start: Date, period: BillingPeriodValue, count = 1): Date {
  const months = (period === 'YEARLY' ? 12 : 1) * count;
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const result = new Date(start);
  result.setUTCFullYear(year, month, Math.min(start.getUTCDate(), lastDay));
  return result;
}

/** Whole days from `from` to `to`, a started day counting as one; 0 when `to` is not later. */
export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.ceil((to.getTime() - from.getTime()) / DAY_MS));
}

/** The pricing fields of a `Plan` row. */
export interface PricingPlan {
  code: PlanCodeValue;
  priceMonthlyXof: number;
  priceYearlyXof: number;
  minSeats: number;
  maxSeats: number | null;
}

/** Price of one seat for one period. */
export function seatPrice(plan: PricingPlan, period: BillingPeriodValue): number {
  return period === 'YEARLY' ? plan.priceYearlyXof : plan.priceMonthlyXof;
}

export function seatsAllowed(plan: PricingPlan, seats: number): boolean {
  return (
    Number.isInteger(seats) &&
    seats >= plan.minSeats &&
    (plan.maxSeats === null || seats <= plan.maxSeats)
  );
}

/** What is bought: a new subscription, a renewal, a higher plan, or extra seats. */
export const ORDER_KINDS = ['NEW', 'RENEW', 'UPGRADE', 'SEATS'] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];

/** The paid subscription an order changes, as needed for its price. */
export interface PricedSubscription {
  periodEnd: Date;
  period: BillingPeriodValue;
  /** Value of the paid time [paidFrom, periodEnd], after promo: base of the upgrade credit. */
  paidValueXof: number;
  paidFrom: Date | null;
}

export interface QuoteInput {
  kind: OrderKind;
  plan: PricingPlan;
  period: BillingPeriodValue;
  /** Seats of the subscription bought; for SEATS, the seats added. */
  seats: number;
  now: Date;
  /** Required for UPGRADE and SEATS. */
  current?: PricedSubscription;
  /** Promo code percentage (NEW and UPGRADE only), already checked. */
  promoPercent?: number | null;
  /** Credit balance of the payer, deducted automatically. */
  creditBalance: number;
  /** Smallest amount of one LigdiCash transaction. */
  minAmount: number;
}

/** A price, line by line. `total` is what LigdiCash charges (0: nothing to pay there). */
export interface Quote {
  /** Price of the seats for the period (SEATS: prorated until the period end). */
  base: number;
  /** Volume discount: 0 until its rate is decided (docs/spec.md, "Points ouverts"). */
  volumeDiscount: number;
  promo: number;
  /** Remaining value of the current period, deducted from a higher plan. */
  prorationCredit: number;
  /** Price after discounts and proration credit, never negative. */
  subtotal: number;
  /** Proration credit beyond the new price: added to the credit balance. */
  prorationSurplus: number;
  creditUsed: number;
  /** Difference added to the credit balance when the remainder is below the minimum. */
  minimumTopUp: number;
  total: number;
  /** Value of the period bought (base minus discounts), kept for later proration. */
  value: number;
}

/**
 * Price of an order. Proration is computed by the day on the real length of the period (step 11
 * default): the upgrade credit is rounded up and the price of extra seats rounded down, both in
 * favour of the customer.
 */
export function quotePrice(input: QuoteInput): Quote {
  const { kind, plan, period, seats, now, current } = input;
  let base: number;
  if (kind === 'SEATS') {
    if (!current) throw new Error('SEATS needs the current subscription');
    const periodStart = addPeriod(current.periodEnd, current.period, -1);
    const periodDays = daysBetween(periodStart, current.periodEnd);
    const remaining = daysBetween(now, current.periodEnd);
    base = periodDays
      ? Math.floor((seatPrice(plan, current.period) * seats * remaining) / periodDays)
      : 0;
  } else {
    base = seatPrice(plan, period) * seats;
  }
  const volumeDiscount = 0;
  const promoPercent = kind === 'NEW' || kind === 'UPGRADE' ? (input.promoPercent ?? 0) : 0;
  const promo = Math.min(
    base - volumeDiscount,
    Math.ceil(((base - volumeDiscount) * promoPercent) / 100),
  );
  const value = base - volumeDiscount - promo;
  let prorationCredit = 0;
  if (kind === 'UPGRADE') {
    if (!current) throw new Error('UPGRADE needs the current subscription');
    prorationCredit = remainingValue(current, now);
  }
  const subtotal = Math.max(0, value - prorationCredit);
  const prorationSurplus = Math.max(0, prorationCredit - value);
  const creditUsed = Math.min(Math.max(0, input.creditBalance), subtotal);
  const rest = subtotal - creditUsed;
  const minimumTopUp = rest > 0 && rest < input.minAmount ? input.minAmount - rest : 0;
  return {
    base,
    volumeDiscount,
    promo,
    prorationCredit,
    subtotal,
    prorationSurplus,
    creditUsed,
    minimumTopUp,
    total: rest + minimumTopUp,
    value,
  };
}

/** Value of the paid time left from `now` to the period end, rounded up. */
export function remainingValue(current: PricedSubscription, now: Date): number {
  if (!current.paidFrom || current.paidValueXof <= 0) return 0;
  const total = daysBetween(current.paidFrom, current.periodEnd);
  const left = Math.min(total, daysBetween(now, current.periodEnd));
  return total ? Math.ceil((current.paidValueXof * left) / total) : 0;
}

/**
 * VAT included in an amount TTC (Plan prices are TTC): HT rounded to the nearest FCFA, VAT the
 * rest, so that HT + VAT is always the amount paid.
 */
export function vatOf(amountTtc: number, ratePercent: number): { ht: number; vat: number } {
  const ht = ratePercent > 0 ? Math.round((amountTtc * 100) / (100 + ratePercent)) : amountTtc;
  return { ht, vat: amountTtc - ht };
}

// ───────────── API schemas ─────────────

const count = z.number().int().nonnegative();
const date = z.iso.datetime();
const id = z.string().min(1).max(64);
const planName = z.object({ fr: z.string(), en: z.string() });
const promoCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9_-]{2,40}$/);

/** Business self-serve form: name of the organization and its optional IFU. */
export const organizationOrderSchema = z.object({
  name: z.string().trim().min(2).max(120),
  ifu: z
    .string()
    .trim()
    .max(40)
    .regex(/^[A-Za-z0-9 -]*$/)
    .optional()
    .transform((value) => value || undefined),
});

export const billingOrderSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('NEW'),
    plan: z.enum(PAID_PLAN_CODES),
    period: z.enum(BILLING_PERIODS),
    seats: z.number().int().min(1).max(100_000),
    organization: organizationOrderSchema.optional(),
    promoCode: promoCode.optional(),
  }),
  z.object({
    kind: z.literal('RENEW'),
    subscriptionId: id,
    plan: z.enum(PAID_PLAN_CODES),
    period: z.enum(BILLING_PERIODS),
    seats: z.number().int().min(1).max(100_000),
  }),
  z.object({
    kind: z.literal('UPGRADE'),
    subscriptionId: id,
    plan: z.enum(PAID_PLAN_CODES),
    period: z.enum(BILLING_PERIODS),
    seats: z.number().int().min(1).max(100_000),
    promoCode: promoCode.optional(),
  }),
  z.object({
    kind: z.literal('SEATS'),
    subscriptionId: id,
    seats: z.number().int().min(1).max(100_000),
  }),
]);
export type BillingOrder = z.infer<typeof billingOrderSchema>;

/** POST /api/billing/quote and POST /api/billing/checkout. */
export const checkoutRequestSchema = z.object({
  order: billingOrderSchema,
  locale: z.enum(['fr', 'en']),
});
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;

export const quoteSchema = z.object({
  planCode: z.enum(PAID_PLAN_CODES),
  period: z.enum(BILLING_PERIODS),
  seats: z.number().int().positive(),
  base: count,
  volumeDiscount: count,
  promo: count,
  promoPercent: z.number().int().min(1).max(100).nullable(),
  prorationCredit: count,
  subtotal: count,
  prorationSurplus: count,
  creditUsed: count,
  minimumTopUp: count,
  total: count,
  creditBalance: count,
  minAmount: count,
  /** When the period bought starts and ends (estimate; set at payment). */
  periodStart: date,
  periodEnd: date,
  /** A verified e-mail is needed before paying (receipts go by e-mail only). */
  emailRequired: z.boolean(),
});
export type BillingQuote = z.infer<typeof quoteSchema>;

export const PAYMENT_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED', 'CREDITED'] as const;
export const PAYMENT_PURPOSES = ['NEW_SUBSCRIPTION', 'RENEWAL', 'UPGRADE', 'EXTRA_SEATS'] as const;

/** Answer of POST /api/billing/checkout: go to LigdiCash, or already active (nothing to pay). */
export const checkoutResponseSchema = z.object({
  paymentId: id,
  redirectUrl: z.url().nullable(),
});
export type CheckoutResponse = z.infer<typeof checkoutResponseSchema>;

export const paymentSummarySchema = z.object({
  id,
  createdAt: date,
  purpose: z.enum(PAYMENT_PURPOSES),
  planCode: z.enum(PLAN_CODES),
  billingPeriod: z.enum(BILLING_PERIODS),
  seats: z.number().int().positive(),
  amountXof: count,
  creditUsedXof: count,
  status: z.enum(PAYMENT_STATUSES),
  /** Amount added to the credit balance by this payment (duplicate, minimum top-up, surplus). */
  creditedXof: count,
  receiptNumber: z.number().int().positive().nullable(),
  organizationName: z.string().nullable(),
});
export type PaymentSummary = z.infer<typeof paymentSummarySchema>;

/** GET /api/billing/payments/:id: status page after LigdiCash. */
export const paymentStatusSchema = paymentSummarySchema.extend({
  /** LigdiCash page, while the payment waits (to pay again from the status page). */
  checkoutUrl: z.url().nullable(),
  supportEmail: z.string().nullable(),
});
export type PaymentStatusView = z.infer<typeof paymentStatusSchema>;

export const SUBSCRIPTION_STATUSES = [
  'TRIALING',
  'ACTIVE',
  'GRACE',
  'PAUSED',
  'EXPIRED',
  'CANCELED',
] as const;

export const billedSubscriptionSchema = z.object({
  id,
  planCode: z.enum(PAID_PLAN_CODES),
  planName,
  status: z.enum(SUBSCRIPTION_STATUSES),
  period: z.enum(BILLING_PERIODS),
  seats: z.number().int().positive(),
  seatsUsed: count,
  organization: z.object({ id, name: z.string() }).nullable(),
  currentPeriodEnd: date,
  graceEndsAt: date.nullable(),
  trialEndsAt: date.nullable(),
  /** Days left when the STANDARD resumes (paused while a TEAM or BUSINESS seat is held). */
  pausedRemainingDays: count.nullable(),
  /** Change paid in advance, applied at the period end. */
  pending: z
    .object({ planCode: z.enum(PAID_PLAN_CODES), period: z.enum(BILLING_PERIODS), seats: count })
    .nullable(),
});
export type BilledSubscription = z.infer<typeof billedSubscriptionSchema>;

export const TRIAL_STATES = ['available', 'trialing', 'used', 'paid', 'subscribed'] as const;
export type TrialState = (typeof TRIAL_STATES)[number];

/** Things to tell the payer once (credit added, grace, end of trial): unread notifications. */
export const BILLING_NOTICE_TYPES = [
  'PAYMENT_CREDITED',
  'RENEWAL_REMINDER',
  'GRACE_STARTED',
  'TRIAL_REMINDER',
  'TRIAL_ENDED',
] as const;
export type BillingNoticeType = (typeof BILLING_NOTICE_TYPES)[number];

export const billingNoticeSchema = z.object({
  id,
  type: z.enum(BILLING_NOTICE_TYPES),
  createdAt: date,
  planCode: z.enum(PLAN_CODES).nullable(),
  /** PAYMENT_CREDITED: amount and receipt; reminders: the date concerned. */
  amountXof: count.nullable(),
  receiptNumber: z.number().int().positive().nullable(),
  date: date.nullable(),
  subscriptionId: id.nullable(),
});
export type BillingNotice = z.infer<typeof billingNoticeSchema>;

/** GET /api/billing: the page "Abonnement". */
export const billingOverviewSchema = z.object({
  subscriptions: z.array(billedSubscriptionSchema),
  creditBalance: count,
  payments: z.array(paymentSummarySchema),
  /**
   * The 14-day STANDARD trial (once per account, never after a paid STANDARD): `available`, in
   * progress (`trialing`, ends at `endsAt`), or why not: `used`, `paid` (a STANDARD was paid),
   * `subscribed` (a STANDARD is held now).
   */
  trial: z.object({
    available: z.boolean(),
    days: z.number().int().positive().nullable(),
    state: z.enum(TRIAL_STATES),
    endsAt: date.nullable(),
  }),
  emailVerified: z.boolean(),
  notices: z.array(billingNoticeSchema),
  supportEmail: z.string().nullable(),
  minAmount: count,
});
export type BillingOverview = z.infer<typeof billingOverviewSchema>;

/** POST /api/billing/notices/read: hides notices from the banner. */
export const readNoticesSchema = z.object({ ids: z.array(id).min(1).max(50) });

/** Development only: outcome chosen on the simulated LigdiCash page. */
export const SIMULATED_OUTCOMES = ['completed', 'notcompleted', 'pending'] as const;
export const simulatedPaymentSchema = z.object({ outcome: z.enum(SIMULATED_OUTCOMES) });
export const simulatedInvoiceSchema = z.object({
  token: z.string(),
  amountXof: count,
  description: z.string(),
  returnUrl: z.url(),
  cancelUrl: z.url(),
});
export type SimulatedInvoice = z.infer<typeof simulatedInvoiceSchema>;

export const BILLING_ERROR_CODES = [
  'plan_unavailable',
  'invalid_seats',
  'organization_required',
  'already_subscribed',
  'not_an_upgrade',
  'subscription_not_found',
  'renewal_pending',
  'subscription_paused',
  'trial_unavailable',
  'promo_invalid',
  'promo_not_applicable',
  'promo_already_used',
  'seats_in_use',
  'payment_not_found',
  'payment_unavailable',
] as const;
