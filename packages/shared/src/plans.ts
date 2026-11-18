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
