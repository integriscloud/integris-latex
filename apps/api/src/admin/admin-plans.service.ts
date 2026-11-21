import type { Plan, Prisma } from '@integris/db';
import {
  type AdminPlan,
  changedTerms,
  PLAN_CODES,
  type PlanCodeValue,
  type PlanRevisionView,
  type PlanTerms,
  planTermsOf,
  QUOTA_TERMS,
} from '@integris/shared';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { revisionTerms } from '../plans/plan-terms.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PlanLimitsService } from '../projects/plan-limits.service.js';
import { isSubscriptionLive } from '../projects/quota.service.js';
import type { AdminActor } from './admin-actor.js';

const LIVE = ['TRIALING', 'ACTIVE', 'GRACE'] as const;

/** Whether a quota of `after` is lower than in `before` (null = unlimited). */
function lowered(before: PlanTerms, after: PlanTerms): boolean {
  const rank = { HIGH: 2, NORMAL: 1, LOW: 0 } as const;
  return QUOTA_TERMS.some((term) => {
    const a = before[term];
    const b = after[term];
    if (term === 'compilePriority') return rank[b as 'LOW'] < rank[a as 'LOW'];
    if (typeof a === 'boolean') return a && !b;
    if (b === null) return false;
    return a === null || (b as number) < (a as number);
  });
}

/**
 * Plans, prices and quotas edited without code (docs/spec.md, "décisions étape 14"). Each change
 * writes the `Plan` row (the current version, read by the price quotes and the FREE quotas) and a
 * new `PlanRevision` (history, frozen by the next paid periods), with an audit entry.
 */
@Injectable()
export class AdminPlansService {
  private readonly logger = new Logger(AdminPlansService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly limits: PlanLimitsService,
  ) {}

  async list(now = new Date()): Promise<AdminPlan[]> {
    const db = this.prisma.client;
    const [plans, revisions, subscriptions] = await Promise.all([
      db.plan.findMany(),
      db.planRevision.findMany({ select: { planId: true, version: true } }),
      db.subscription.findMany({
        where: { status: { in: [...LIVE] } },
        select: { planId: true, status: true, currentPeriodEnd: true, graceEndsAt: true },
      }),
    ]);
    return plans
      .sort((a, b) => PLAN_CODES.indexOf(a.code) - PLAN_CODES.indexOf(b.code))
      .map((plan) => ({
        code: plan.code,
        version: Math.max(
          1,
          ...revisions.filter((row) => row.planId === plan.id).map((row) => row.version),
        ),
        terms: planTermsOf(plan),
        updatedAt: plan.updatedAt.toISOString(),
        liveSubscriptions: subscriptions.filter(
          (row) => row.planId === plan.id && isSubscriptionLive(row, now),
        ).length,
      }));
  }

  private async plan(code: string): Promise<Plan> {
    const plan = (PLAN_CODES as readonly string[]).includes(code)
      ? await this.prisma.client.plan.findUnique({ where: { code: code as PlanCodeValue } })
      : null;
    if (!plan) throw new ApiError(HttpStatus.NOT_FOUND, 'not_found');
    return plan;
  }

  async revisions(code: string): Promise<PlanRevisionView[]> {
    const plan = await this.plan(code);
    const rows = await this.prisma.client.planRevision.findMany({
      where: { planId: plan.id },
      include: { changedBy: { select: { displayName: true } } },
      orderBy: { version: 'desc' },
    });
    return rows.flatMap((row, index) => {
      const terms = revisionTerms(row);
      if (!terms) return [];
      const previous = rows[index + 1] ? revisionTerms(rows[index + 1]!) : null;
      return [
        {
          version: row.version,
          terms,
          changed: previous ? changedTerms(previous, terms) : [],
          reason: row.reason,
          changedBy: row.changedBy?.displayName ?? null,
          createdAt: row.createdAt.toISOString(),
        },
      ];
    });
  }

  /** Rules of the grid the back-office cannot break. */
  private check(code: PlanCodeValue, terms: PlanTerms): void {
    const personal = code === 'FREE' || code === 'STANDARD';
    const invalid =
      (code === 'FREE' && (terms.priceMonthlyXof !== 0 || terms.priceYearlyXof !== 0)) ||
      (code !== 'FREE' && (terms.priceMonthlyXof === 0 || terms.priceYearlyXof === 0)) ||
      (personal && (terms.minSeats !== 1 || terms.maxSeats !== 1)) ||
      (terms.maxSeats !== null && terms.maxSeats < terms.minSeats) ||
      // Self-serve trials exist for STANDARD only; the BUSINESS pilot trial is given by hand.
      (code !== 'STANDARD' && terms.trialDays !== null) ||
      (!terms.supervisionDashboard && terms.maxSupervisedStudents !== null) ||
      (code !== 'BUSINESS' && terms.maxAdmins !== 0);
    if (invalid) throw new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, 'plan_terms_invalid');
  }

  async update(
    actor: AdminActor,
    code: string,
    terms: PlanTerms,
    reason: string,
  ): Promise<PlanRevisionView[]> {
    const plan = await this.plan(code);
    this.check(plan.code, terms);
    const before = planTermsOf(plan);
    const changed = changedTerms(before, terms);
    if (!changed.length) return this.revisions(code);
    await this.prisma.client.$transaction(async (tx) => {
      const last = await tx.planRevision.findFirst({
        where: { planId: plan.id },
        orderBy: { version: 'desc' },
      });
      const version = (last?.version ?? 0) + 1;
      await tx.plan.update({
        where: { id: plan.id },
        data: { ...terms, storageBytes: BigInt(terms.storageBytes) },
      });
      await tx.planRevision.create({
        data: {
          planId: plan.id,
          version,
          terms: terms as unknown as Prisma.InputJsonObject,
          reason,
          changedById: actor.userId,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.userId,
          action: 'ADMIN_PLAN_UPDATED',
          targetType: 'Plan',
          targetId: plan.id,
          metadata: {
            code: plan.code,
            version,
            reason,
            changes: Object.fromEntries(
              changed.map((key) => [key, { from: before[key], to: terms[key] }]),
            ),
          },
          ip: actor.ip,
        },
      });
    });
    // Limits applied again in the background: a FREE quota lowered applies at once (read-only
    // beyond it, step 10); a quota raised frees read-only projects at once.
    void this.reconcile(plan.code === 'FREE' && lowered(before, terms));
    return this.revisions(code);
  }

  private async reconcile(everyOwner: boolean): Promise<void> {
    try {
      const owners = await this.prisma.client.project.findMany({
        where: everyOwner
          ? { deletedAt: null }
          : { readOnlyReason: { not: null }, deletedAt: null },
        distinct: ['ownerId'],
        select: { ownerId: true },
      });
      for (const { ownerId } of owners) await this.limits.reconcileQuietly(ownerId);
    } catch (error) {
      this.logger.error(
        { err: (error as Error).message },
        'Plan limits not applied after a change',
      );
    }
  }
}
