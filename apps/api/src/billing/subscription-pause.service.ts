import type { Prisma } from '@integris/db';
import { daysBetween } from '@integris/shared';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { isSubscriptionLive } from '../projects/quota.service.js';

const DAY_MS = 86_400_000;

/**
 * A paid STANDARD is paused, and extended by as much, while its holder occupies a TEAM or
 * BUSINESS seat; it resumes when they lose the seat (docs/spec.md, "Standard déjà payé"; no
 * credit, step 11 decision). Trials are not paused. Called when a payment is applied and by the
 * billing scheduler; seat changes of step 12 call it too.
 */
@Injectable()
export class SubscriptionPauseService {
  constructor(private readonly prisma: PrismaService) {}

  /** Pauses or resumes the user's STANDARD. Returns true when something changed. */
  async sync(userId: string, now = new Date()): Promise<boolean> {
    const db = this.prisma.client;
    const seats = await db.seat.findMany({
      where: { userId, releasedAt: null },
      include: { subscription: true },
    });
    const holdsSeat = seats.some(
      (seat) =>
        seat.subscription.organizationId !== null && isSubscriptionLive(seat.subscription, now),
    );
    const personal = await db.subscription.findMany({
      where: { userId, status: holdsSeat ? 'ACTIVE' : 'PAUSED' },
      include: { plan: true },
    });
    let changed = false;
    for (const subscription of personal) {
      if (subscription.plan.code !== 'STANDARD') continue;
      if (holdsSeat && subscription.currentPeriodEnd <= now) continue;
      await db.$transaction(async (tx) => {
        const data: Prisma.SubscriptionUpdateManyMutationInput = holdsSeat
          ? {
              status: 'PAUSED',
              pausedAt: now,
              pausedRemainingDays: daysBetween(now, subscription.currentPeriodEnd),
            }
          : resumeData(subscription, now);
        const done = await tx.subscription.updateMany({
          where: { id: subscription.id, status: subscription.status },
          data,
        });
        if (!done.count) return;
        changed = true;
        await tx.auditLog.create({
          data: {
            actorId: null,
            action: holdsSeat ? 'SUBSCRIPTION_PAUSED' : 'SUBSCRIPTION_RESUMED',
            targetType: 'Subscription',
            targetId: subscription.id,
            metadata: holdsSeat
              ? { remainingDays: daysBetween(now, subscription.currentPeriodEnd) }
              : { remainingDays: subscription.pausedRemainingDays },
          },
        });
      });
    }
    return changed;
  }
}

function resumeData(
  subscription: {
    pausedAt: Date | null;
    pausedRemainingDays: number | null;
    paidFromAt: Date | null;
  },
  now: Date,
): Prisma.SubscriptionUpdateManyMutationInput {
  const shift = subscription.pausedAt ? now.getTime() - subscription.pausedAt.getTime() : 0;
  return {
    status: 'ACTIVE',
    currentPeriodEnd: new Date(now.getTime() + (subscription.pausedRemainingDays ?? 0) * DAY_MS),
    // The paid time moves with the pause, so the upgrade credit stays the same.
    paidFromAt: subscription.paidFromAt
      ? new Date(subscription.paidFromAt.getTime() + shift)
      : null,
    pausedAt: null,
    pausedRemainingDays: null,
  };
}
