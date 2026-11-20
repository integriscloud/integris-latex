import type { SubscriptionStatus } from '@integris/db';
import { READ_ONLY_REASONS, SUBSCRIPTION_GRACE_DAYS } from '@integris/shared';
import {
  HttpStatus,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ApiConfig } from '../config/api-config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { OwnerLockService } from './owner-lock.service.js';
import { ProjectEventsService } from './project-events.service.js';
import { fail } from './projects.service.js';
import { QuotaService } from './quota.service.js';

const OVER = READ_ONLY_REASONS.overPlanLimit;
const DAY_MS = 86_400_000;
const SWEEP_MS = 10 * 60_000;
const LIVE_STATUSES: SubscriptionStatus[] = ['TRIALING', 'ACTIVE', 'GRACE'];

interface OwnedProject {
  id: string;
  readOnlyReason: string | null;
}

/**
 * Projects to switch so that at most `max` projects are writable (docs/spec.md, "Lecture seule
 * au-delà des limites"). `projects` are the owner's projects outside the trash, most recently
 * active first. The current choice is kept: writable projects stay writable as long as there
 * is room, the least recently active ones become read-only first, and a free place goes to the
 * most recently active read-only project. Only OVER_PLAN_LIMIT is managed here.
 */
export function planWritable(
  projects: readonly OwnedProject[],
  max: number | null,
): { toReadOnly: string[]; toWritable: string[] } {
  const writable = projects.filter((project) => project.readOnlyReason === null);
  const readOnly = projects.filter((project) => project.readOnlyReason === OVER);
  if (max === null) return { toReadOnly: [], toWritable: readOnly.map((project) => project.id) };
  if (writable.length > max) {
    return { toReadOnly: writable.slice(max).map((project) => project.id), toWritable: [] };
  }
  return {
    toReadOnly: [],
    toWritable: readOnly.slice(0, max - writable.length).map((project) => project.id),
  };
}

/**
 * Applies the project limit of the owner's plan to their projects: beyond it, projects become
 * read-only; nothing is deleted. Called when a plan changes (end of subscription, upgrade,
 * `pnpm dev:plan`), when a project goes to or comes back from the trash, and every 10 minutes
 * for the subscriptions whose grace ended.
 */
@Injectable()
export class PlanLimitsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PlanLimitsService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly quota: QuotaService,
    private readonly locks: OwnerLockService,
    private readonly events: ProjectEventsService,
    private readonly redis: RedisService,
    private readonly config: ApiConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.runSweep(), SWEEP_MS);
    this.timer.unref();
    setTimeout(() => void this.runSweep(), 45_000).unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** Applies the plan's project limit to an owner's projects; returns the projects switched. */
  async reconcile(ownerId: string): Promise<string[]> {
    const changed = await this.locks.run(ownerId, async () => {
      const { maxProjects } = await this.quota.quotas(ownerId);
      const db = this.prisma.client;
      const projects = await db.project.findMany({
        where: { ownerId, deletedAt: null },
        select: { id: true, readOnlyReason: true },
        orderBy: [{ lastActivityAt: 'desc' }, { createdAt: 'desc' }],
      });
      const { toReadOnly, toWritable } = planWritable(projects, maxProjects);
      if (!toReadOnly.length && !toWritable.length) return [];
      await db.$transaction([
        db.project.updateMany({
          where: { id: { in: toReadOnly }, readOnlyReason: null },
          data: { readOnlyReason: OVER },
        }),
        db.project.updateMany({
          where: { id: { in: toWritable }, readOnlyReason: OVER },
          data: { readOnlyReason: null },
        }),
      ]);
      return [...toReadOnly, ...toWritable];
    });
    await this.announce(changed);
    if (changed.length)
      this.logger.log({ ownerId, changed: changed.length }, 'Plan limits applied');
    return changed;
  }

  /** reconcile, logged instead of thrown (after an action that already succeeded). */
  async reconcileQuietly(ownerId: string): Promise<void> {
    await this.reconcile(ownerId).catch((error: unknown) =>
      this.logger.warn({ err: (error as Error).message, ownerId }, 'Plan limits not applied'),
    );
  }

  /**
   * Makes a read-only project writable (owner only). When every writable place is taken,
   * `release` names the writable project that becomes read-only instead.
   */
  async makeWritable(ownerId: string, projectId: string, release?: string): Promise<void> {
    const changed = await this.locks.run(ownerId, async () => {
      const db = this.prisma.client;
      const projects = await db.project.findMany({
        where: { ownerId, deletedAt: null },
        select: { id: true, readOnlyReason: true },
      });
      const target = projects.find((project) => project.id === projectId);
      if (!target) return fail(HttpStatus.NOT_FOUND, 'not_found');
      if (target.readOnlyReason !== OVER) return fail(HttpStatus.CONFLICT, 'not_read_only');
      const { maxProjects } = await this.quota.quotas(ownerId);
      const writable = projects.filter((project) => project.readOnlyReason === null).length;
      if (maxProjects === null || writable < maxProjects) {
        await db.project.updateMany({
          where: { id: projectId, readOnlyReason: OVER },
          data: { readOnlyReason: null },
        });
        return [projectId];
      }
      const released = projects.find((project) => project.id === release);
      if (!release) return fail(HttpStatus.CONFLICT, 'release_required');
      if (!released || released.readOnlyReason !== null) {
        return fail(HttpStatus.UNPROCESSABLE_ENTITY, 'invalid_release');
      }
      await db.$transaction([
        db.project.updateMany({
          where: { id: released.id, readOnlyReason: null },
          data: { readOnlyReason: OVER },
        }),
        db.project.updateMany({
          where: { id: projectId, readOnlyReason: OVER },
          data: { readOnlyReason: null },
        }),
      ]);
      return [released.id, projectId];
    });
    await this.announce(changed);
  }

  /**
   * Subscriptions whose grace ended are marked EXPIRED and the limits of the users who held them
   * (the personal subscriber, or the holders of its seats) are applied again. Reminders and the
   * GRACE status come with the payments (step 11).
   */
  async sweep(now = new Date()): Promise<number> {
    const db = this.prisma.client;
    const lapsed = await db.subscription.findMany({
      where: {
        status: { in: LIVE_STATUSES },
        OR: [
          { graceEndsAt: { lte: now } },
          {
            graceEndsAt: null,
            currentPeriodEnd: { lte: new Date(now.getTime() - SUBSCRIPTION_GRACE_DAYS * DAY_MS) },
          },
        ],
      },
      select: {
        id: true,
        userId: true,
        seats: { where: { releasedAt: null }, select: { userId: true } },
      },
      take: 200,
    });
    for (const subscription of lapsed) {
      const expired = await db.$transaction(async (tx) => {
        const changed = await tx.subscription.updateMany({
          where: { id: subscription.id, status: { in: LIVE_STATUSES } },
          data: { status: 'EXPIRED' },
        });
        if (changed.count) {
          await tx.auditLog.create({
            data: {
              actorId: null,
              action: 'SUBSCRIPTION_EXPIRED',
              targetType: 'Subscription',
              targetId: subscription.id,
              metadata: { reason: 'grace_over' },
            },
          });
        }
        return changed.count;
      });
      if (!expired) continue;
      const holders = new Set(
        [subscription.userId, ...subscription.seats.map((seat) => seat.userId)].filter(
          (id): id is string => id !== null,
        ),
      );
      for (const userId of holders) await this.reconcile(userId);
    }
    // Owners with read-only projects whose last reconcile failed (owner lock busy, database
    // down) get their free places back.
    const owners = await db.project.findMany({
      where: { readOnlyReason: READ_ONLY_REASONS.overPlanLimit, deletedAt: null },
      distinct: ['ownerId'],
      select: { ownerId: true },
      take: 500,
    });
    for (const { ownerId } of owners) await this.reconcileQuietly(ownerId);
    return lapsed.length;
  }

  private async runSweep(): Promise<void> {
    try {
      const lock = await this.redis.client.set('lock:plan-sweep', '1', 'PX', SWEEP_MS, 'NX');
      if (lock !== 'OK') return;
      const expired = await this.sweep();
      if (expired) this.logger.log({ expired }, 'Lapsed subscriptions expired');
    } catch (error) {
      this.logger.error({ err: error }, 'Plan sweep failed');
    }
  }

  /** Open editors read their rights again (collab) and the pages reload the project. */
  private async announce(projectIds: string[]): Promise<void> {
    for (const projectId of projectIds) {
      await this.events.publish({ type: 'project-access', projectId });
    }
  }
}
