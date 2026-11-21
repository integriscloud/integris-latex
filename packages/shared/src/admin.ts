import { z } from 'zod';
import { PAID_PLAN_CODES } from './billing.js';
import { NOTIFICATION_CATEGORIES } from './notifications.js';
import { PLAN_CODES, planTermsSchema } from './plans.js';

// Back-office of Integris (docs/spec.md, "Back-office Integris" and "Back-office et notifications
// (décisions étape 14)"). Only metadata, numbers and amounts: never a project name, a file or an
// exam subject.

export const ADMIN_ERROR_CODES = [
  // Not a super-administrator (the back-office answers as if it did not exist).
  'admin_not_found',
  // A sensitive action needs a recent SMS code (ADMIN_REAUTH_SECONDS).
  'admin_reauth_required',
  'plan_terms_invalid',
  'user_not_found',
  'organization_not_found',
  'credit_insufficient',
  // A credited duplicate is marked refunded only by a refund that covers it.
  'refund_below_payment',
  'promo_not_found',
  'promo_code_taken',
  // Percentage and plans of a code no longer change after its first use.
  'promo_locked',
  'promo_max_below_used',
  'business_trial_used',
  'business_trial_not_found',
  'business_trial_limit',
  'trial_seats_invalid',
] as const;

/** BUSINESS pilot trial: initial length, longest total length, default seats. */
export const BUSINESS_TRIAL_DAYS = 30;
export const BUSINESS_TRIAL_MAX_DAYS = 60;
export const BUSINESS_TRIAL_DEFAULT_SEATS = 10;

export const PUBLIC_TEMPLATE_CATEGORIES = [
  'memoire',
  'rapport',
  'article',
  'beamer',
  'cv',
  'autre',
] as const;

const id = z.string().min(1).max(64);
const date = z.iso.datetime();
const amount = z.number().int().nonnegative();
const reason = z.string().trim().min(3).max(500);
const note = reason;

// ───────────── Requests ─────────────

export const updatePlanSchema = z.object({ terms: planTermsSchema, reason });

export const adminSearchSchema = z.object({
  q: z.string().trim().max(120).optional(),
  before: z.string().max(64).optional(),
});

export const adminPaymentsQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED', 'CREDITED']).optional(),
  before: z.string().max(64).optional(),
});

export const addCreditSchema = z.object({
  amountXof: z.number().int().positive().max(100_000_000),
  note,
});

export const refundSchema = z.object({
  amountXof: z.number().int().positive().max(100_000_000),
  note,
  /** Reference of the transfer made outside the platform (LigdiCash, Mobile Money). */
  reference: z.string().trim().min(3).max(120),
  /** Credited duplicate paid back by this refund. */
  paymentId: id.optional(),
});

export const startBusinessTrialSchema = z.object({
  ownerId: id,
  organizationName: z.string().trim().min(2).max(120),
  seats: z.number().int().positive().max(5000).default(BUSINESS_TRIAL_DEFAULT_SEATS),
});

export const extendBusinessTrialSchema = z.object({
  days: z.number().int().positive().max(BUSINESS_TRIAL_MAX_DAYS),
  reason,
});

export const PROMO_CODE = /^[A-Z0-9-]{3,32}$/;

export const createPromoSchema = z.object({
  code: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(PROMO_CODE)),
  percentOff: z.number().int().min(1).max(100),
  planCodes: z.array(z.enum(PAID_PLAN_CODES)).max(PAID_PLAN_CODES.length),
  validUntil: date.nullable(),
  maxRedemptions: z.number().int().positive().max(1_000_000).nullable(),
});

export const updatePromoSchema = z
  .object({
    percentOff: z.number().int().min(1).max(100).optional(),
    planCodes: z.array(z.enum(PAID_PLAN_CODES)).max(PAID_PLAN_CODES.length).optional(),
    validUntil: date.nullable().optional(),
    maxRedemptions: z.number().int().positive().max(1_000_000).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'empty' });

const templateName = z.string().trim().min(1).max(120);
const templateDescription = z.string().trim().max(280);
const templateInstitution = z.string().trim().max(120);

export const adminTemplateQuerySchema = z.object({
  name: templateName,
  description: templateDescription.optional(),
  category: z.enum(PUBLIC_TEMPLATE_CATEGORIES),
  institution: templateInstitution.optional(),
});

export const updateAdminTemplateSchema = z
  .object({
    name: templateName.optional(),
    description: templateDescription.nullable().optional(),
    category: z.enum(PUBLIC_TEMPLATE_CATEGORIES).optional(),
    institution: templateInstitution.nullable().optional(),
    published: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'empty' });

// ───────────── Responses ─────────────

export const adminSessionSchema = z.object({
  /** Until when sensitive actions are allowed (ISO), or null. */
  reauthUntil: date.nullable(),
  hasPhone: z.boolean(),
});
export type AdminSession = z.infer<typeof adminSessionSchema>;

export const adminPlanSchema = z.object({
  code: z.enum(PLAN_CODES),
  version: z.number().int().positive(),
  terms: planTermsSchema,
  updatedAt: date,
  /** Subscriptions live now on this plan (paid and trials). */
  liveSubscriptions: z.number().int().nonnegative(),
});
export type AdminPlan = z.infer<typeof adminPlanSchema>;
export const adminPlansSchema = z.array(adminPlanSchema);

export const planRevisionViewSchema = z.object({
  version: z.number().int().positive(),
  terms: planTermsSchema,
  /** Fields changed from the previous version. */
  changed: z.array(z.string()),
  reason: z.string(),
  changedBy: z.string().nullable(),
  createdAt: date,
});
export type PlanRevisionView = z.infer<typeof planRevisionViewSchema>;
export const planRevisionsSchema = z.array(planRevisionViewSchema);

const planHeld = z.object({
  planCode: z.enum(PLAN_CODES),
  kind: z.enum(['personal', 'seat']),
  status: z.string(),
  organizationName: z.string().nullable(),
  periodEnd: date,
});

export const adminUserRowSchema = z.object({
  id,
  displayName: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  createdAt: date,
  disabled: z.boolean(),
  superAdmin: z.boolean(),
});
export type AdminUserRow = z.infer<typeof adminUserRowSchema>;
export const adminUserListSchema = z.object({
  users: z.array(adminUserRowSchema),
  nextCursor: z.string().nullable(),
});

const paymentRow = z.object({
  id,
  userId: id,
  userName: z.string(),
  purpose: z.string(),
  planCode: z.enum(PLAN_CODES),
  seats: z.number().int().positive(),
  amountXof: amount,
  creditUsedXof: amount,
  status: z.string(),
  receiptNumber: z.number().int().positive().nullable(),
  providerTransactionId: z.string().nullable(),
  duplicateReason: z.string().nullable(),
  createdAt: date,
  verifiedAt: date.nullable(),
  refundedAt: date.nullable(),
});
export type AdminPaymentRow = z.infer<typeof paymentRow>;
export const adminPaymentListSchema = z.object({
  payments: z.array(paymentRow),
  nextCursor: z.string().nullable(),
});

const creditRow = z.object({
  id,
  amountXof: z.number().int(),
  reason: z.string(),
  note: z.string().nullable(),
  reference: z.string().nullable(),
  paymentId: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: date,
});

export const adminUserDetailSchema = z.object({
  user: adminUserRowSchema.extend({
    locale: z.enum(['fr', 'en']),
    emailVerified: z.boolean(),
    emailNotifications: z.array(z.enum(NOTIFICATION_CATEGORIES)),
  }),
  plans: z.array(planHeld),
  organizations: z.array(
    z.object({ id, name: z.string(), type: z.enum(['TEAM', 'BUSINESS']), role: z.string() }),
  ),
  usage: z.object({
    projects: z.number().int().nonnegative(),
    storageBytes: z.number().int().nonnegative(),
    compilesThisMonth: z.number().int().nonnegative(),
  }),
  creditBalance: amount,
  credits: z.array(creditRow),
  payments: z.array(paymentRow),
  businessTrialUsed: z.boolean(),
});
export type AdminUserDetail = z.infer<typeof adminUserDetailSchema>;

const subscriptionView = z.object({
  id,
  planCode: z.enum(PLAN_CODES),
  status: z.string(),
  billingPeriod: z.enum(['MONTHLY', 'YEARLY']),
  seatCount: z.number().int().positive(),
  currentPeriodStart: date,
  currentPeriodEnd: date,
  trialEndsAt: date.nullable(),
  planVersion: z.number().int().positive().nullable(),
});

export const adminOrgRowSchema = z.object({
  id,
  name: z.string(),
  type: z.enum(['TEAM', 'BUSINESS']),
  ownerName: z.string().nullable(),
  members: z.number().int().nonnegative(),
  subscription: subscriptionView.nullable(),
  pilotTrial: z.boolean(),
  createdAt: date,
});
export type AdminOrgRow = z.infer<typeof adminOrgRowSchema>;
export const adminOrgListSchema = z.object({
  organizations: z.array(adminOrgRowSchema),
  nextCursor: z.string().nullable(),
});

export const adminOrgDetailSchema = z.object({
  organization: adminOrgRowSchema.extend({ ifu: z.string().nullable() }),
  seats: z.object({ total: z.number().int(), used: z.number().int() }),
  members: z.array(
    z.object({
      userId: id,
      displayName: z.string(),
      role: z.string(),
      kind: z.string(),
      status: z.string(),
    }),
  ),
  /** Pilot trial: when it started and how many days it may still be extended by. */
  trial: z
    .object({ startedAt: date, endsAt: date, extendableDays: z.number().int().nonnegative() })
    .nullable(),
});
export type AdminOrgDetail = z.infer<typeof adminOrgDetailSchema>;

export const adminPromoSchema = z.object({
  id,
  code: z.string(),
  percentOff: z.number().int(),
  planCodes: z.array(z.enum(PLAN_CODES)),
  validUntil: date.nullable(),
  maxRedemptions: z.number().int().nullable(),
  redemptionCount: z.number().int().nonnegative(),
  isActive: z.boolean(),
  createdAt: date,
});
export type AdminPromo = z.infer<typeof adminPromoSchema>;
export const adminPromoListSchema = z.array(adminPromoSchema);

export const adminTemplateSchema = z.object({
  id,
  name: z.string(),
  description: z.string().nullable(),
  category: z.string(),
  institution: z.string().nullable(),
  published: z.boolean(),
  projects: z.number().int().nonnegative(),
  createdAt: date,
});
export type AdminTemplate = z.infer<typeof adminTemplateSchema>;
export const adminTemplateListSchema = z.array(adminTemplateSchema);

const month = z.object({
  /** First day of the month, "2026-11". */
  month: z.string().regex(/^\d{4}-\d{2}$/),
  signups: z.number().int().nonnegative(),
  revenueXof: z.number().int(),
  compilations: z.number().int().nonnegative(),
  compileMinutes: z.number().int().nonnegative(),
});

export const adminStatsSchema = z.object({
  totals: z.object({
    users: z.number().int().nonnegative(),
    payingUsers: z.number().int().nonnegative(),
    payingOrganizations: z.number().int().nonnegative(),
    trials: z.number().int().nonnegative(),
    revenueXof: z.number().int(),
    compilations: z.number().int().nonnegative(),
  }),
  months: z.array(month),
});
export type AdminStats = z.infer<typeof adminStatsSchema>;
