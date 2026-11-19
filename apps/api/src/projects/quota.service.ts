import type { CompilePriority, Plan, PlanCode, SubscriptionStatus } from '@integris/db';
import { PLAN_CODES, type ProjectUsage } from '@integris/shared';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/** Subscriptions whose plan applies. Status changes (expiry, grace, pause) belong to step 11. */
const LIVE_STATUSES: SubscriptionStatus[] = ['TRIALING', 'ACTIVE', 'GRACE'];

/** Quotas of the plans a user holds, combined: the best value of each quota wins. */
export interface EffectiveQuotas {
  /** Highest plan held, for display and upgrade offers. */
  planCode: PlanCode;
  planName: { fr: string; en: string };
  maxProjects: number | null;
  /** Collaborators per project (owner and supervisors not counted); null = unlimited. */
  maxCollaborators: number | null;
  storageBytes: bigint;
  maxCompileSeconds: number;
  maxCompilesPerHour: number;
  autoCompile: boolean;
  compilePriority: CompilePriority;
  /** Days of version history shown and restorable; null = unlimited. */
  historyDays: number | null;
}

/** Compilation priorities, best first. */
const PRIORITY_ORDER: CompilePriority[] = ['HIGH', 'NORMAL', 'LOW'];

/** Best quotas of several plans (null = unlimited beats any number). */
export function combineQuotas(plans: readonly Plan[]): EffectiveQuotas {
  if (!plans.length) throw new Error('At least the FREE plan is required');
  const best = (values: (number | null)[]) =>
    values.includes(null) ? null : Math.max(...(values as number[]));
  const highest = plans.reduce((a, b) =>
    PLAN_CODES.indexOf(b.code) > PLAN_CODES.indexOf(a.code) ? b : a,
  );
  return {
    planCode: highest.code,
    planName: { fr: highest.nameFr, en: highest.nameEn },
    maxProjects: best(plans.map((plan) => plan.maxProjects)),
    maxCollaborators: best(plans.map((plan) => plan.maxCollaboratorsPerProject)),
    storageBytes: plans.map((plan) => plan.storageBytes).reduce((a, b) => (b > a ? b : a)),
    maxCompileSeconds: Math.max(...plans.map((plan) => plan.maxCompileSeconds)),
    maxCompilesPerHour: Math.max(...plans.map((plan) => plan.maxCompilesPerHour)),
    autoCompile: plans.some((plan) => plan.autoCompile),
    compilePriority: PRIORITY_ORDER.find((priority) =>
      plans.some((plan) => plan.compilePriority === priority),
    )!,
    historyDays: best(plans.map((plan) => plan.historyDays)),
  };
}

/**
 * Quotas of a user, read from the `Plan` table: the FREE plan, the personal subscription and every
 * seat held in a TEAM or BUSINESS. Quotas are per seat and never pooled; usage is charged to the
 * owner of the project.
 */
@Injectable()
export class QuotaService {
  constructor(private readonly prisma: PrismaService) {}

  async quotas(userId: string): Promise<EffectiveQuotas> {
    const db = this.prisma.client;
    const [free, personal, seats] = await Promise.all([
      db.plan.findUniqueOrThrow({ where: { code: 'FREE' } }),
      db.subscription.findMany({
        where: { userId, status: { in: LIVE_STATUSES } },
        include: { plan: true },
      }),
      db.seat.findMany({
        where: { userId, releasedAt: null, subscription: { status: { in: LIVE_STATUSES } } },
        include: { subscription: { include: { plan: true } } },
      }),
    ]);
    return combineQuotas([
      free,
      ...personal.map((subscription) => subscription.plan),
      ...seats.map((seat) => seat.subscription.plan),
    ]);
  }

  /** Projects counted against the limit: owned and not in the trash. */
  countProjects(ownerId: string): Promise<number> {
    return this.prisma.client.project.count({ where: { ownerId, deletedAt: null } });
  }

  /** Storage used by an owner: every file of their projects, the trash included. */
  async storageUsed(ownerId: string): Promise<bigint> {
    const result = await this.prisma.client.projectFile.aggregate({
      where: { project: { ownerId } },
      _sum: { sizeBytes: true },
    });
    return BigInt(result._sum.sizeBytes ?? 0);
  }

  async usage(userId: string): Promise<ProjectUsage> {
    const [quotas, projects, storage] = await Promise.all([
      this.quotas(userId),
      this.countProjects(userId),
      this.storageUsed(userId),
    ]);
    return {
      planCode: quotas.planCode,
      planName: quotas.planName,
      projects,
      maxProjects: quotas.maxProjects,
      storageBytes: Number(storage),
      maxStorageBytes: Number(quotas.storageBytes),
    };
  }
}
