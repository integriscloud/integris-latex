import { z } from 'zod';
import { PLAN_CODES } from './plans.js';

/**
 * Why a project is read-only (`Project.readOnlyReason`). OVER_PLAN_LIMIT: beyond the project
 * limit of the owner's plan after a subscription ended (docs/spec.md, "Fin d'abonnement").
 */
export const READ_ONLY_REASONS = { overPlanLimit: 'OVER_PLAN_LIMIT' } as const;

/** Days a subscription keeps applying after its paid period (docs/spec.md, "Renouvellement"). */
export const SUBSCRIPTION_GRACE_DAYS = 7;

/** Share of a quota from which the user is warned (docs/spec.md, "Alertes de consommation"). */
export const QUOTA_WARN_RATIO = 0.8;

export const USAGE_LEVELS = ['ok', 'warn', 'full'] as const;
export type UsageLevel = (typeof USAGE_LEVELS)[number];

/** Quotas that raise alerts at 80 % and 100 %. */
export const ALERT_QUOTAS = ['projects', 'storage', 'compilesPerHour'] as const;
export type AlertQuota = (typeof ALERT_QUOTAS)[number];

/** Level of a quota: `full` once the limit is reached, `warn` from 80 %; null = unlimited. */
export function usageLevel(used: number, max: number | null): UsageLevel {
  if (max === null) return 'ok';
  if (used >= max) return 'full';
  return used >= max * QUOTA_WARN_RATIO ? 'warn' : 'ok';
}

/** First day of the month of a date, in UTC (the period of `UsageCounter`). */
export function usagePeriodStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

const count = z.number().int().nonnegative();
const date = z.iso.datetime();
const planName = z.object({ fr: z.string(), en: z.string() });

const meterSchema = z.object({
  used: count,
  /** null = unlimited. */
  max: count.nullable(),
  level: z.enum(USAGE_LEVELS),
});
export type UsageMeter = z.infer<typeof meterSchema>;

const ownedProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  lastActivityAt: date,
});

/** GET /api/usage: the page "Ma consommation". */
export const accountUsageSchema = z.object({
  /** Highest plan held (quotas are the best of every source). */
  plan: z.object({ code: z.enum(PLAN_CODES), name: planName }),
  /** Where the quotas come from: the free plan, the personal subscription, each seat. */
  sources: z.array(
    z.object({
      kind: z.enum(['free', 'personal', 'seat']),
      planCode: z.enum(PLAN_CODES),
      planName,
      organizationName: z.string().nullable(),
      /** End of the period (grace excluded); null for the free plan. */
      periodEnd: date.nullable(),
    }),
  ),
  projects: meterSchema,
  storage: meterSchema,
  compilesPerHour: meterSchema.extend({
    /** Seconds until the oldest compilation of the hour leaves the window; null when none. */
    nextSlotSeconds: count.nullable(),
  }),
  month: z.object({ periodStart: date, compileCount: count, compileSeconds: count }),
  limits: z.object({
    maxCollaborators: count.nullable(),
    maxCompileSeconds: count,
    historyDays: count.nullable(),
    autoCompile: z.boolean(),
    compilePriority: z.enum(['HIGH', 'NORMAL', 'LOW']),
    supervisionDashboard: z.boolean(),
    maxSupervisedStudents: count.nullable(),
  }),
  /** Credit balance (FCFA) deducted from the next payment (step 11). */
  creditBalance: count,
  /** Owned projects outside the trash. */
  writable: z.array(ownedProjectSchema),
  readOnly: z.array(ownedProjectSchema),
});
export type AccountUsage = z.infer<typeof accountUsageSchema>;

/** POST /api/projects/:id/writable: makes a read-only project writable, releasing another. */
export const makeWritableSchema = z.object({ release: z.string().min(1).max(64).optional() });
export type MakeWritableRequest = z.infer<typeof makeWritableSchema>;
