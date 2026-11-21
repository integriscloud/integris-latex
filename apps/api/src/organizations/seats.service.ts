import type { Prisma, Seat } from '@integris/db';
import { SEAT_REASSIGN_DAYS, type SeatSummary } from '@integris/shared';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { SubscriptionPauseService } from '../billing/subscription-pause.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PlanLimitsService } from '../projects/plan-limits.service.js';
import { fail, OrgContextService, type OrgActor, type Tx } from './org-context.service.js';

const DAY_MS = 86_400_000;

type SeatState = 'held' | 'reserved' | 'waiting' | 'free';

/** State of a seat: occupied, reserved by a pending invitation, released < 30 days ago, or free. */
export function seatState(seat: Seat, now: Date): SeatState {
  if (seat.userId && !seat.releasedAt) return 'held';
  if (seat.invitationId) return 'reserved';
  if (seat.reassignableAt && seat.reassignableAt > now) return 'waiting';
  return 'free';
}

export function summarize(seats: readonly Seat[], now: Date): SeatSummary {
  const count = (state: SeatState) => seats.filter((seat) => seatState(seat, now) === state).length;
  const waiting = seats
    .filter((seat) => seatState(seat, now) === 'waiting')
    .map((seat) => seat.reassignableAt!.getTime());
  return {
    total: seats.length,
    held: count('held'),
    reserved: count('reserved'),
    waiting: waiting.length,
    free: count('free'),
    nextFreeAt: waiting.length ? new Date(Math.min(...waiting)).toISOString() : null,
  };
}

/**
 * Seats of a TEAM or BUSINESS (docs/spec.md, "Règles des comptes et des sièges" and step 12
 * decisions): the owner holds one; a pending invitation reserves one, given back at once if it is
 * not accepted; a seat released by its holder waits 30 days before it can be given again. Every
 * change writes an audit entry in the transaction that makes it. Callers hold the organization
 * lock.
 */
@Injectable()
export class SeatsService {
  private readonly logger = new Logger(SeatsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly context: OrgContextService,
    private readonly pause: SubscriptionPauseService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  async summary(subscriptionId: string, now = new Date()): Promise<SeatSummary> {
    const seats = await this.prisma.client.seat.findMany({ where: { subscriptionId } });
    return summarize(seats, now);
  }

  /** Marks the expired pending invitations of an organization and gives their seats back. */
  async expireInvitations(organizationId: string, now = new Date()): Promise<void> {
    const db = this.prisma.client;
    const expired = await db.invitation.findMany({
      where: { organizationId, status: 'PENDING', expiresAt: { lte: now } },
      select: { id: true },
    });
    if (!expired.length) return;
    const ids = expired.map((invitation) => invitation.id);
    await db.$transaction(async (tx) => {
      await tx.invitation.updateMany({
        where: { id: { in: ids }, status: 'PENDING' },
        data: { status: 'EXPIRED', decidedAt: now },
      });
      await this.unreserve(tx, { userId: null, ip: null }, ids, 'expired');
    });
  }

  /**
   * A free seat, or 402 `no_free_seat` (the owner can buy more). Held and reserved seats never
   * exceed the seats paid, nor the seat count of a lower renewal already paid.
   */
  async freeSeat(tx: Tx, subscriptionId: string, now: Date): Promise<Seat> {
    const subscription = await tx.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    const taken = await tx.seat.count({
      where: {
        subscriptionId,
        OR: [{ userId: { not: null }, releasedAt: null }, { invitationId: { not: null } }],
      },
    });
    const paid = Math.min(
      subscription.seatCount,
      subscription.pendingSeatCount ?? subscription.seatCount,
    );
    if (taken >= paid) return fail(HttpStatus.PAYMENT_REQUIRED, 'no_free_seat');
    const seat = await tx.seat.findFirst({
      where: {
        subscriptionId,
        invitationId: null,
        OR: [{ userId: null }, { releasedAt: { not: null } }],
        AND: [{ OR: [{ reassignableAt: null }, { reassignableAt: { lte: now } }] }],
      },
      orderBy: { createdAt: 'asc' },
    });
    return seat ?? fail(HttpStatus.PAYMENT_REQUIRED, 'no_free_seat');
  }

  async reserve(
    tx: Tx,
    actor: OrgActor,
    subscriptionId: string,
    invitationId: string,
    now: Date,
  ): Promise<Seat> {
    const seat = await this.freeSeat(tx, subscriptionId, now);
    await this.take(tx, seat, { invitationId });
    await this.context.audit(tx, actor, 'SEAT_RESERVED', 'Seat', seat.id, {
      subscriptionId,
      invitationId,
    });
    return seat;
  }

  /**
   * Writes a seat only if it is still as it was read (free, or reserved by `reservedFor`): a seat
   * deleted by a renewal with fewer seats, or taken meanwhile, refuses with `no_free_seat`.
   */
  private async take(
    tx: Tx,
    seat: Seat,
    data: Prisma.SeatUncheckedUpdateManyInput,
    reservedFor: string | null = null,
  ): Promise<void> {
    const { count } = await tx.seat.updateMany({
      where: reservedFor
        ? { id: seat.id, invitationId: reservedFor }
        : {
            id: seat.id,
            invitationId: null,
            OR: [{ userId: null }, { releasedAt: { not: null } }],
          },
      data,
    });
    if (!count) fail(HttpStatus.PAYMENT_REQUIRED, 'no_free_seat');
  }

  /** Gives back the seats reserved by these invitations (declined, expired, revoked, not sent). */
  async unreserve(tx: Tx, actor: OrgActor, invitationIds: string[], reason: string) {
    const seats = await tx.seat.findMany({ where: { invitationId: { in: invitationIds } } });
    for (const seat of seats) {
      await tx.seat.update({ where: { id: seat.id }, data: { invitationId: null } });
      await this.context.audit(tx, actor, 'SEAT_UNRESERVED', 'Seat', seat.id, {
        subscriptionId: seat.subscriptionId,
        invitationId: seat.invitationId,
        reason,
      });
    }
  }

  /** Gives a seat to a member: the given one (reserved for them), else a free one. */
  async assign(
    tx: Tx,
    actor: OrgActor,
    subscriptionId: string,
    userId: string,
    now: Date,
    seat?: Seat | null,
  ): Promise<Seat> {
    const target = seat ?? (await this.freeSeat(tx, subscriptionId, now));
    await this.take(
      tx,
      target,
      { userId, assignedAt: now, releasedAt: null, reassignableAt: null, invitationId: null },
      seat?.invitationId ?? null,
    );
    await this.context.audit(tx, actor, 'SEAT_ASSIGNED', 'Seat', target.id, {
      subscriptionId,
      userId,
    });
    return target;
  }

  /** Releases the member's seat: reassignable only 30 days later. */
  async release(
    tx: Tx,
    actor: OrgActor,
    subscriptionId: string,
    userId: string,
    now: Date,
    reason: string,
  ): Promise<void> {
    const seats = await tx.seat.findMany({ where: { subscriptionId, userId, releasedAt: null } });
    const reassignableAt = new Date(now.getTime() + SEAT_REASSIGN_DAYS * DAY_MS);
    for (const seat of seats) {
      await tx.seat.update({ where: { id: seat.id }, data: { releasedAt: now, reassignableAt } });
      await this.context.audit(tx, actor, 'SEAT_RELEASED', 'Seat', seat.id, {
        subscriptionId,
        userId,
        reason,
        reassignableAt: reassignableAt.toISOString(),
      });
    }
  }

  /**
   * After a seat changed hands: the member's paid STANDARD pauses or resumes, and the limits of
   * their effective plan apply to their projects (read-only beyond the limits, nothing deleted).
   */
  async applied(userIds: Iterable<string>): Promise<void> {
    for (const userId of new Set(userIds)) {
      await this.pause
        .sync(userId)
        .catch((error: unknown) =>
          this.logger.warn({ err: (error as Error).message, userId }, 'Standard pause not synced'),
        );
      await this.planLimits.reconcileQuietly(userId);
    }
  }
}
