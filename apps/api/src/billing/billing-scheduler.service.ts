import type { Subscription } from '@integris/db';
import {
  addPeriod,
  GRACE_REMINDER_DAYS,
  RENEWAL_REMINDER_DAYS,
  SUBSCRIPTION_GRACE_DAYS,
  TRIAL_REMINDER_DAYS,
} from '@integris/shared';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ApiConfig } from '../config/api-config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { OwnerLockService } from '../projects/owner-lock.service.js';
import { PlanLimitsService } from '../projects/plan-limits.service.js';
import { RedisService } from '../redis/redis.service.js';
import { billingSms, formatDate } from './billing-messages.js';
import { BillingNotifier } from './billing-notifier.service.js';
import { payerOf } from './billing-orders.js';
import { billingLockKey, PaymentProcessor } from './payment-processor.service.js';
import { ReceiptsService } from './receipts.service.js';
import { SubscriptionPauseService } from './subscription-pause.service.js';

const DAY_MS = 86_400_000;
const SWEEP_MS = 10 * 60_000;

type Named = Subscription & { plan: { nameFr: string; nameEn: string } };

/**
 * Billing tasks every 10 minutes (one API process at a time, Redis lock), in this order: pending
 * payments checked again, changes paid in advance applied at the period end, periods ended →
 * GRACE (7 days, then FREE by PlanLimitsService.sweep), reminders (renewal 5 and 1 days before by
 * SMS with a direct link, end of trial 3 days before, end of grace 3 days before to the members),
 * pauses of STANDARD, receipts not sent yet. No automatic charge ever.
 */
@Injectable()
export class BillingScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(BillingScheduler.name);
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ApiConfig,
    private readonly locks: OwnerLockService,
    private readonly limits: PlanLimitsService,
    private readonly processor: PaymentProcessor,
    private readonly receipts: ReceiptsService,
    private readonly pause: SubscriptionPauseService,
    private readonly notifier: BillingNotifier,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.env.NODE_ENV === 'test') return;
    this.first = setTimeout(() => void this.run(), 60_000).unref();
    this.timer = setInterval(() => void this.run(), SWEEP_MS).unref();
  }

  onModuleDestroy(): void {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }

  private async run(): Promise<void> {
    try {
      const lock = await this.redis.client.set('lock:billing-sweep', '1', 'PX', SWEEP_MS, 'NX');
      if (lock !== 'OK') return;
      await this.sweep();
    } catch (error) {
      this.logger.error({ err: error }, 'Billing sweep failed');
    }
  }

  async sweep(now = new Date()): Promise<void> {
    const steps: [string, () => Promise<unknown>][] = [
      ['pending payments', () => this.processor.sweepPending(now)],
      ['pending changes', () => this.applyPendingChanges(now)],
      ['grace', () => this.startGrace(now)],
      ['renewal reminders', () => this.renewalReminders(now)],
      ['trial reminders', () => this.trialReminders(now)],
      ['grace reminders', () => this.graceReminders(now)],
      ['pauses', () => this.syncPauses(now)],
      ['receipts', () => this.receipts.deliverPending(now)],
    ];
    for (const [name, step] of steps) {
      try {
        await step();
      } catch (error) {
        this.logger.error({ err: error, step: name }, 'Billing sweep step failed');
      }
    }
  }

  private link(locale: string, subscriptionId?: string): string {
    const base = `${this.config.env.PUBLIC_WEB_URL}/${locale}/app/billing`;
    return subscriptionId ? `${base}/checkout?renew=${subscriptionId}` : `${base}/checkout`;
  }

  /** Lower plan, other period or seat count paid in advance: applied when the period ends. */
  async applyPendingChanges(now: Date): Promise<number> {
    const db = this.prisma.client;
    const due = await db.subscription.findMany({
      where: {
        status: { in: ['ACTIVE', 'GRACE'] },
        pendingPlanId: { not: null },
        currentPeriodEnd: { lte: now },
      },
      take: 200,
    });
    for (const subscription of due) {
      const payer = await payerOf(db, subscription);
      await this.locks.runKey(billingLockKey(payer ?? subscription.id), () =>
        db.$transaction(async (tx) => {
          const current = await tx.subscription.findUnique({
            where: { id: subscription.id },
            include: { seats: { where: { releasedAt: null } } },
          });
          if (!current?.pendingPlanId || current.currentPeriodEnd > now) return;
          const period = current.pendingBillingPeriod ?? current.billingPeriod;
          const seats = current.pendingSeatCount ?? current.seatCount;
          const start = current.currentPeriodEnd;
          const plan = await tx.plan.findUniqueOrThrow({ where: { id: current.pendingPlanId } });
          await tx.subscription.update({
            where: { id: current.id },
            data: {
              planId: plan.id,
              billingPeriod: period,
              seatCount: seats,
              status: 'ACTIVE',
              graceEndsAt: null,
              currentPeriodStart: start,
              currentPeriodEnd: addPeriod(start, period),
              paidValueXof: current.pendingValueXof ?? 0,
              paidFromAt: start,
              pendingPlanId: null,
              pendingBillingPeriod: null,
              pendingSeatCount: null,
              pendingValueXof: null,
            },
          });
          if (current.organizationId) {
            await tx.organization.update({
              where: { id: current.organizationId },
              data: { type: plan.code === 'TEAM' ? 'TEAM' : 'BUSINESS' },
            });
          }
          // Free seats beyond the new count are removed (held seats were checked at payment).
          const free = current.seats.filter((seat) => seat.userId === null && !seat.assignedAt);
          const extra = current.seats.length - seats;
          if (extra > 0) {
            await tx.seat.deleteMany({
              where: { id: { in: free.slice(0, extra).map((seat) => seat.id) } },
            });
          } else if (extra < 0) {
            await tx.seat.createMany({
              data: Array.from({ length: -extra }, () => ({ subscriptionId: current.id })),
            });
          }
          await tx.auditLog.create({
            data: {
              actorId: null,
              action: 'SUBSCRIPTION_CHANGE_APPLIED',
              targetType: 'Subscription',
              targetId: current.id,
              metadata: { planCode: plan.code, period, seats },
            },
          });
        }),
      );
      const holders = await db.seat.findMany({
        where: { subscriptionId: subscription.id, releasedAt: null, userId: { not: null } },
      });
      for (const userId of new Set([subscription.userId, ...holders.map((seat) => seat.userId)])) {
        if (userId) await this.limits.reconcileQuietly(userId);
      }
    }
    return due.length;
  }

  /** Paid periods that ended without renewal: 7 days of grace, the plan still applies. */
  async startGrace(now: Date): Promise<number> {
    const db = this.prisma.client;
    const ended = await db.subscription.findMany({
      where: { status: 'ACTIVE', currentPeriodEnd: { lte: now }, pendingPlanId: null },
      include: { plan: true },
      take: 200,
    });
    for (const subscription of ended) {
      const graceEndsAt = new Date(
        subscription.currentPeriodEnd.getTime() + SUBSCRIPTION_GRACE_DAYS * DAY_MS,
      );
      const changed = await db.$transaction(async (tx) => {
        const done = await tx.subscription.updateMany({
          where: { id: subscription.id, status: 'ACTIVE', currentPeriodEnd: { lte: now } },
          data: { status: 'GRACE', graceEndsAt },
        });
        if (done.count) {
          await tx.auditLog.create({
            data: {
              actorId: null,
              action: 'SUBSCRIPTION_GRACE_STARTED',
              targetType: 'Subscription',
              targetId: subscription.id,
              metadata: { graceEndsAt: graceEndsAt.toISOString() },
            },
          });
        }
        return done.count > 0;
      });
      if (!changed || graceEndsAt <= now) continue;
      const payer = await payerOf(db, subscription);
      if (!payer) continue;
      const key = `grace:${subscription.id}:${subscription.currentPeriodEnd.toISOString()}`;
      await this.notifier.inApp(
        db,
        payer,
        'GRACE_STARTED',
        {
          planCode: subscription.plan.code,
          date: graceEndsAt.toISOString(),
          subscriptionId: subscription.id,
        },
        key,
      );
      await this.notifier.smsOnce(payer, 'GRACE_STARTED', key, (locale) =>
        billingSms.graceStarted[locale](
          planName(subscription, locale),
          formatDate(graceEndsAt),
          this.link(locale, subscription.id),
        ),
      );
    }
    return ended.length;
  }

  /** SMS 5 days and 1 day before the end of a paid period, with a direct payment link. */
  async renewalReminders(now: Date): Promise<number> {
    const db = this.prisma.client;
    const horizon = new Date(now.getTime() + Math.max(...RENEWAL_REMINDER_DAYS) * DAY_MS);
    const ending = await db.subscription.findMany({
      where: {
        status: 'ACTIVE',
        pendingPlanId: null,
        currentPeriodEnd: { gt: now, lte: horizon },
      },
      include: { plan: true },
      take: 500,
    });
    let sent = 0;
    for (const subscription of ending) {
      const left = subscription.currentPeriodEnd.getTime() - now.getTime();
      // The closest reminder only (a subscription bought 2 days before its end gets the 1-day one).
      const days = Math.min(...RENEWAL_REMINDER_DAYS.filter((day) => left <= day * DAY_MS));
      const payer = await payerOf(db, subscription);
      if (!payer) continue;
      const key = `renewal:${subscription.id}:${subscription.currentPeriodEnd.toISOString()}:${days}`;
      const fresh = await this.notifier.inApp(
        db,
        payer,
        'RENEWAL_REMINDER',
        {
          planCode: subscription.plan.code,
          date: subscription.currentPeriodEnd.toISOString(),
          subscriptionId: subscription.id,
        },
        key,
      );
      if (!fresh) continue;
      sent++;
      await this.notifier.smsOnce(payer, 'RENEWAL_REMINDER', key, (locale) =>
        billingSms.renewal[locale](
          planName(subscription, locale),
          formatDate(subscription.currentPeriodEnd),
          this.link(locale, subscription.id),
        ),
      );
    }
    return sent;
  }

  /** 3 days before the end of a trial (no grace after it: back to FREE directly). */
  async trialReminders(now: Date): Promise<number> {
    const db = this.prisma.client;
    const trials = await db.subscription.findMany({
      where: {
        status: 'TRIALING',
        currentPeriodEnd: { gt: now, lte: new Date(now.getTime() + TRIAL_REMINDER_DAYS * DAY_MS) },
      },
      take: 500,
    });
    let sent = 0;
    for (const trial of trials) {
      if (!trial.userId) continue;
      const key = `trial:${trial.id}`;
      const fresh = await this.notifier.inApp(
        db,
        trial.userId,
        'TRIAL_REMINDER',
        {
          planCode: 'STANDARD',
          date: trial.currentPeriodEnd.toISOString(),
          subscriptionId: trial.id,
        },
        key,
      );
      if (!fresh) continue;
      sent++;
      await this.notifier.smsOnce(trial.userId, 'TRIAL_REMINDER', key, (locale) =>
        billingSms.trialEnding[locale](formatDate(trial.currentPeriodEnd), this.link(locale)),
      );
    }
    // Trials that ended (expired by PlanLimitsService.sweep, or about to be): told once.
    const ended = await db.subscription.findMany({
      where: {
        status: { in: ['TRIALING', 'EXPIRED'] },
        trialEndsAt: { not: null, lte: now, gt: new Date(now.getTime() - 2 * DAY_MS) },
      },
      take: 500,
    });
    for (const trial of ended) {
      // Converted to a paid STANDARD: the trial end is not the end of the plan.
      if (!trial.userId || trial.currentPeriodEnd.getTime() !== trial.trialEndsAt?.getTime())
        continue;
      await this.notifier.inApp(
        db,
        trial.userId,
        'TRIAL_ENDED',
        {
          planCode: 'STANDARD',
          date: trial.currentPeriodEnd.toISOString(),
          subscriptionId: trial.id,
        },
        `trial-ended:${trial.id}`,
      );
    }
    return sent;
  }

  /** 3 days before the end of the grace: every member is told by SMS (docs/spec.md). */
  async graceReminders(now: Date): Promise<number> {
    const db = this.prisma.client;
    const ending = await db.subscription.findMany({
      where: {
        status: 'GRACE',
        graceEndsAt: { gt: now, lte: new Date(now.getTime() + GRACE_REMINDER_DAYS * DAY_MS) },
      },
      include: { plan: true, seats: { where: { releasedAt: null, userId: { not: null } } } },
      take: 200,
    });
    let sent = 0;
    for (const subscription of ending) {
      const payer = await payerOf(db, subscription);
      const people = new Set(
        [payer, subscription.userId, ...subscription.seats.map((seat) => seat.userId)].filter(
          (id): id is string => id !== null,
        ),
      );
      for (const userId of people) {
        const key = `grace-ending:${subscription.id}:${subscription.graceEndsAt!.toISOString()}:${userId}`;
        if (
          await this.notifier.smsOnce(userId, 'GRACE_STARTED', key, (locale) =>
            billingSms.graceEnding[locale](
              planName(subscription, locale),
              formatDate(subscription.graceEndsAt!),
            ),
          )
        ) {
          sent++;
        }
      }
    }
    return sent;
  }

  /** STANDARD paused or resumed as TEAM and BUSINESS seats come and go. */
  async syncPauses(now: Date): Promise<number> {
    const db = this.prisma.client;
    const [paused, seats] = await Promise.all([
      db.subscription.findMany({
        where: { status: 'PAUSED' },
        select: { userId: true },
        take: 500,
      }),
      db.seat.findMany({
        where: { userId: { not: null }, releasedAt: null },
        select: { userId: true },
        take: 2000,
      }),
    ]);
    const users = new Set(
      [...paused.map((row) => row.userId), ...seats.map((row) => row.userId)].filter(
        (id): id is string => id !== null,
      ),
    );
    let changed = 0;
    for (const userId of users) {
      if (await this.pause.sync(userId, now)) {
        changed++;
        await this.limits.reconcileQuietly(userId);
      }
    }
    return changed;
  }
}

function planName(subscription: Named, locale: 'fr' | 'en'): string {
  return locale === 'fr' ? subscription.plan.nameFr : subscription.plan.nameEn;
}
