import { z } from 'zod';

/** Plan codes, in display order (cheapest first). */
export const PLAN_CODES = ['FREE', 'STANDARD', 'TEAM', 'BUSINESS'] as const;
export type PlanCodeValue = (typeof PLAN_CODES)[number];

const count = z.number().int().nonnegative();

/**
 * A plan as exposed publicly by GET /api/plans (pricing page). Read from the `Plan` table, never
 * hard-coded. Prices are integer XOF, TTC, per seat for TEAM and BUSINESS. `null` means unlimited.
 * Undecided or out-of-V1 fields (volume discount rate, AI requests) are deliberately left out.
 */
export const publicPlanSchema = z.object({
  code: z.enum(PLAN_CODES),
  nameFr: z.string().min(1),
  nameEn: z.string().min(1),
  priceMonthlyXof: count,
  priceYearlyXof: count,
  minSeats: z.number().int().positive(),
  maxSeats: z.number().int().positive().nullable(),
  maxProjects: count.nullable(),
  maxCollaboratorsPerProject: count.nullable(),
  maxCompileSeconds: z.number().int().positive(),
  maxCompilesPerHour: z.number().int().positive(),
  storageBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  historyDays: z.number().int().positive().nullable(),
  autoCompile: z.boolean(),
  supervisionDashboard: z.boolean(),
  maxSupervisedStudents: z.number().int().positive().nullable(),
  compilePriority: z.enum(['HIGH', 'NORMAL', 'LOW']),
  trialDays: z.number().int().positive().nullable(),
});
export type PublicPlan = z.infer<typeof publicPlanSchema>;

export const publicPlansSchema = z.array(publicPlanSchema);

// ───────────── Plan versions (back-office, step 14) ─────────────

const positive = z.number().int().positive();
const unlimited = (schema: z.ZodNumber) => schema.nullable();

/** Fields priced per paid period: a change only applies to new paid periods. */
export const PRICE_TERMS = [
  'priceMonthlyXof',
  'priceYearlyXof',
  'minSeats',
  'maxSeats',
  'trialDays',
] as const;

/** Quotas: a higher value applies at once, a lower one at the next paid period (FREE: at once). */
export const QUOTA_TERMS = [
  'maxProjects',
  'maxCollaboratorsPerProject',
  'maxCompileSeconds',
  'maxCompilesPerHour',
  'storageBytes',
  'historyDays',
  'autoCompile',
  'supervisionDashboard',
  'maxSupervisedStudents',
  'aiRequestsPerDay',
  'compilePriority',
  'maxAdmins',
] as const;

export type QuotaTerm = (typeof QUOTA_TERMS)[number];

/**
 * Prices and quotas of a plan, as edited in the back-office and kept in each `PlanRevision`.
 * Amounts are integer XOF, TTC; `null` means unlimited. The volume discount rate is left out
 * (open point of docs/spec.md).
 */
export const planTermsSchema = z.object({
  nameFr: z.string().trim().min(1).max(40),
  nameEn: z.string().trim().min(1).max(40),
  priceMonthlyXof: count.max(10_000_000),
  priceYearlyXof: count.max(100_000_000),
  minSeats: positive.max(100_000),
  maxSeats: unlimited(positive.max(100_000)),
  trialDays: unlimited(positive.max(365)),
  maxProjects: unlimited(count.max(1_000_000)),
  maxCollaboratorsPerProject: unlimited(count.max(100_000)),
  maxCompileSeconds: positive.max(3600),
  maxCompilesPerHour: positive.max(100_000),
  storageBytes: positive.max(Number.MAX_SAFE_INTEGER),
  historyDays: unlimited(positive.max(36_500)),
  autoCompile: z.boolean(),
  supervisionDashboard: z.boolean(),
  maxSupervisedStudents: unlimited(positive.max(100_000)),
  aiRequestsPerDay: count.max(100_000),
  compilePriority: z.enum(['HIGH', 'NORMAL', 'LOW']),
  maxAdmins: count.max(1000),
});
export type PlanTerms = z.infer<typeof planTermsSchema>;

/** The terms of a `Plan` row (storage as a number of bytes). */
export function planTermsOf(
  plan: Omit<PlanTerms, 'storageBytes'> & { storageBytes: bigint | number },
): PlanTerms {
  const terms = Object.fromEntries(
    Object.keys(planTermsSchema.shape).map((key) => [key, plan[key as keyof PlanTerms]]),
  ) as PlanTerms;
  return { ...terms, storageBytes: Number(plan.storageBytes) };
}

const PRIORITY_RANK = { HIGH: 2, NORMAL: 1, LOW: 0 } as const;

/** Whether quota value `a` is at least as generous as `b` (null = unlimited beats any number). */
function atLeast(term: QuotaTerm, a: unknown, b: unknown): boolean {
  if (term === 'compilePriority') {
    return (
      PRIORITY_RANK[a as keyof typeof PRIORITY_RANK] >=
      PRIORITY_RANK[b as keyof typeof PRIORITY_RANK]
    );
  }
  if (typeof a === 'boolean') return a || !b;
  if (a === null) return true;
  if (b === null) return false;
  return (a as number) >= (b as number);
}

/**
 * Terms of a subscription that froze version `frozen` of its plan while `current` is the plan
 * now (docs/spec.md, "décisions étape 14"): the prices of the frozen version, and quota by quota
 * the more generous of both (a higher quota applies at once, a lower one at the next period).
 */
export function frozenTerms<T extends Record<QuotaTerm | (typeof PRICE_TERMS)[number], unknown>>(
  current: T,
  frozen: Partial<Record<QuotaTerm | (typeof PRICE_TERMS)[number], unknown>>,
): T {
  const result: Record<string, unknown> = { ...current };
  for (const term of PRICE_TERMS) {
    if (term in frozen) result[term] = frozen[term];
  }
  for (const term of QUOTA_TERMS) {
    if (!(term in frozen)) continue;
    if (!atLeast(term, current[term], frozen[term])) result[term] = frozen[term];
  }
  return result as T;
}

/** Changes between two versions of a plan, for the history of the back-office. */
export function changedTerms(before: PlanTerms, after: PlanTerms): (keyof PlanTerms)[] {
  return (Object.keys(planTermsSchema.shape) as (keyof PlanTerms)[]).filter(
    (key) => before[key] !== after[key],
  );
}
