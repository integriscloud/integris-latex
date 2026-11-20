import type { CompilePriority, Plan, PlanCode, SubscriptionStatus } from '@integris/db';
import {
  PLAN_CODES,
  type ProjectUsage,
  SUBSCRIPTION_GRACE_DAYS,
  usagePeriodStart,
} from '@integris/shared';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';

/** Statuses whose plan applies, within their dates. The dates are checked here so that a lapsed
 * subscription never gives its quotas, even before the sweeps change its status. */
const LIVE_STATUSES: SubscriptionStatus[] = ['TRIALING', 'ACTIVE', 'GRACE'];

const DAY_MS = 86_400_000;
const HOUR_MS = 3600_000;

/** Sliding one-hour window of the compilations charged to an owner (Redis sorted set). */
export const compileHourKey = (ownerId: string) => `compile:hour:${ownerId}`;

interface SubscriptionDates {
  status: SubscriptionStatus;
  currentPeriodEnd: Date;
  graceEndsAt: Date | null;
}

/**
 * Until when a subscription applies: its grace end, else its period end plus the grace days. A
 * trial has no grace: it ends with its period (step 11 decision).
 */
export function subscriptionLiveUntil(subscription: SubscriptionDates): Date | null {
  if (!LIVE_STATUSES.includes(subscription.status)) return null;
  if (subscription.status === 'TRIALING') return subscription.currentPeriodEnd;
  return (
    subscription.graceEndsAt ??
    new Date(subscription.currentPeriodEnd.getTime() + SUBSCRIPTION_GRACE_DAYS * DAY_MS)
  );
}

export function isSubscriptionLive(subscription: SubscriptionDates, now = new Date()): boolean {
  const until = subscriptionLiveUntil(subscription);
  return until !== null && until > now;
}

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
  supervisionDashboard: boolean;
  /** Students followed per supervisor in the dashboard; null = unlimited. */
  maxSupervisedStudents: number | null;
}

/** A plan held by a user and where it comes from. */
export interface QuotaSource {
  kind: 'free' | 'personal' | 'seat';
  plan: Plan;
  organizationName: string | null;
  periodEnd: Date | null;
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
  const supervising = plans.filter((plan) => plan.supervisionDashboard);
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
    supervisionDashboard: supervising.length > 0,
    maxSupervisedStudents: supervising.length
      ? best(supervising.map((plan) => plan.maxSupervisedStudents))
      : null,
  };
}

/**
 * Quotas of a user, read from the `Plan` table: the FREE plan, the personal subscription and every
 * seat held in a TEAM or BUSINESS. Quotas are per seat and never pooled; usage is charged to the
 * owner of the project.
 */
@Injectable()
export class QuotaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Every plan the user holds now, the free plan first. */
  async sources(userId: string, now = new Date()): Promise<QuotaSource[]> {
    const db = this.prisma.client;
    const [free, personal, seats] = await Promise.all([
      db.plan.findUniqueOrThrow({ where: { code: 'FREE' } }),
      db.subscription.findMany({
        where: { userId, status: { in: LIVE_STATUSES } },
        include: { plan: true },
      }),
      db.seat.findMany({
        where: { userId, releasedAt: null, subscription: { status: { in: LIVE_STATUSES } } },
        include: {
          subscription: { include: { plan: true, organization: { select: { name: true } } } },
        },
      }),
    ]);
    return [
      { kind: 'free', plan: free, organizationName: null, periodEnd: null },
      ...personal
        .filter((subscription) => isSubscriptionLive(subscription, now))
        .map((subscription) => ({
          kind: 'personal' as const,
          plan: subscription.plan,
          organizationName: null,
          periodEnd: subscription.currentPeriodEnd,
        })),
      ...seats
        .filter((seat) => isSubscriptionLive(seat.subscription, now))
        .map((seat) => ({
          kind: 'seat' as const,
          plan: seat.subscription.plan,
          organizationName: seat.subscription.organization?.name ?? null,
          periodEnd: seat.subscription.currentPeriodEnd,
        })),
    ];
  }

  async quotas(userId: string): Promise<EffectiveQuotas> {
    return combineQuotas((await this.sources(userId)).map((source) => source.plan));
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

  /**
   * Compilations of the last hour charged to an owner, and in how many seconds the oldest one
   * leaves the window (null when there is none).
   */
  async compilesThisHour(
    ownerId: string,
  ): Promise<{ used: number; nextSlotSeconds: number | null }> {
    const now = Date.now();
    const key = compileHourKey(ownerId);
    const [, [, used], [, oldest]] = (await this.redis.client
      .multi()
      .zremrangebyscore(key, '-inf', String(now - HOUR_MS))
      .zcard(key)
      .zrange(key, '0', '0', 'WITHSCORES')
      .exec()) as [unknown, [unknown, number], [unknown, string[]]];
    const first = oldest[1] === undefined ? null : Number(oldest[1]);
    return {
      used,
      nextSlotSeconds:
        first === null ? null : Math.max(1, Math.ceil((first + HOUR_MS - now) / 1000)),
    };
  }

  /** Counts a finished compilation in the monthly counter of the owner it is charged to. */
  async chargeCompilation(ownerId: string, durationMs: number, at = new Date()): Promise<void> {
    // Whole seconds rounded down: the counter never holds more than the real duration.
    const seconds = Math.floor(Math.max(0, durationMs) / 1000);
    const periodStart = usagePeriodStart(at);
    await this.prisma.client.usageCounter.upsert({
      where: { userId_periodStart: { userId: ownerId, periodStart } },
      create: { userId: ownerId, periodStart, compileCount: 1, compileSeconds: seconds },
      update: { compileCount: { increment: 1 }, compileSeconds: { increment: seconds } },
    });
  }

  /** Records the storage of an owner in the counter of the month (last value seen). */
  async recordStorage(ownerId: string, bytes: bigint, at = new Date()): Promise<void> {
    const periodStart = usagePeriodStart(at);
    await this.prisma.client.usageCounter.upsert({
      where: { userId_periodStart: { userId: ownerId, periodStart } },
      create: { userId: ownerId, periodStart, storageBytes: bytes },
      update: { storageBytes: bytes },
    });
  }

  /** Counter of the month of a user (zeros when nothing was charged yet). */
  async month(userId: string, at = new Date()) {
    const periodStart = usagePeriodStart(at);
    const row = await this.prisma.client.usageCounter.findUnique({
      where: { userId_periodStart: { userId, periodStart } },
    });
    return {
      periodStart,
      compileCount: row?.compileCount ?? 0,
      compileSeconds: row?.compileSeconds ?? 0,
    };
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
