import type { Plan, PlanRevision, Prisma } from '@integris/db';
import { frozenTerms, type PlanTerms, planTermsSchema } from '@integris/shared';

type Db = Prisma.TransactionClient;

/** Id of the current version of a plan (each back-office change adds one). */
export async function latestRevisionId(db: Db, planId: string): Promise<string | null> {
  const revision = await db.planRevision.findFirst({
    where: { planId },
    orderBy: { version: 'desc' },
    select: { id: true },
  });
  return revision?.id ?? null;
}

/** Terms kept in a version; null if the row cannot be read (then the current plan applies). */
export function revisionTerms(revision: Pick<PlanRevision, 'terms'>): PlanTerms | null {
  const parsed = planTermsSchema.safeParse(revision.terms);
  return parsed.success ? parsed.data : null;
}

/**
 * The plan a subscription holds (docs/spec.md, "décisions étape 14"): the prices of the version
 * its paid period (or trial) froze, and quota by quota the more generous of that version and the
 * current plan. Without a frozen version, the current plan.
 */
export function effectivePlan(plan: Plan, revision: Pick<PlanRevision, 'terms'> | null): Plan {
  const terms = revision ? revisionTerms(revision) : null;
  if (!terms) return plan;
  return frozenTerms(plan, { ...terms, storageBytes: BigInt(terms.storageBytes) });
}

/** A subscription read with its plan and frozen version, seen with its effective plan. */
export function withEffectivePlan<
  T extends { plan: Plan; planRevision?: Pick<PlanRevision, 'terms'> | null },
>(subscription: T): T {
  return {
    ...subscription,
    plan: effectivePlan(subscription.plan, subscription.planRevision ?? null),
  };
}
