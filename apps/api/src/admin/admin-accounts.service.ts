import type { Prisma } from '@integris/db';
import {
  type AdminOrgDetail,
  type AdminOrgRow,
  type AdminPaymentRow,
  type AdminUserDetail,
  type AdminUserRow,
  type ApiErrorCode,
  BUSINESS_TRIAL_DAYS,
  BUSINESS_TRIAL_MAX_DAYS,
  usagePeriodStart,
} from '@integris/shared';
import { HttpStatus, Injectable } from '@nestjs/common';
import { creditBalanceOf } from '../billing/billing-orders.js';
import { billingLockKey } from '../billing/payment-processor.service.js';
import { ApiError } from '../common/api-error.js';
import { ApiConfig } from '../config/api-config.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { SeatsService } from '../organizations/seats.service.js';
import { latestRevisionId } from '../plans/plan-terms.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { OwnerLockService } from '../projects/owner-lock.service.js';
import { isSubscriptionLive } from '../projects/quota.service.js';
import type { AdminActor } from './admin-actor.js';

type Tx = Prisma.TransactionClient;

const PAGE = 50;
const DAY_MS = 86_400_000;

const fail = (status: HttpStatus, code: ApiErrorCode): never => {
  throw new ApiError(status, code);
};

const userInclude = {
  receipt: { select: { number: true } },
  user: { select: { displayName: true } },
} satisfies Prisma.PaymentInclude;

type PaymentWithUser = Prisma.PaymentGetPayload<{ include: typeof userInclude }>;

/** Rows of a list, with the cursor of the next page (creation time of the last row). */
function page<T extends { createdAt: Date }>(rows: T[]): { rows: T[]; nextCursor: string | null } {
  const shown = rows.slice(0, PAGE);
  return {
    rows: shown,
    nextCursor: rows.length > PAGE ? shown.at(-1)!.createdAt.toISOString() : null,
  };
}

const before = (cursor: string | undefined) => {
  if (!cursor) return {};
  const date = new Date(cursor);
  return Number.isNaN(date.getTime()) ? {} : { createdAt: { lt: date } };
};

/**
 * Accounts in the back-office (docs/spec.md, "décisions étape 14"): users and organizations in
 * consultation, payments, manual credits and refunds, BUSINESS pilot trials. Only accounts,
 * numbers and amounts: no project name, file or exam subject is ever read here.
 */
@Injectable()
export class AdminAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: OwnerLockService,
    private readonly seats: SeatsService,
    private readonly notifications: NotificationsService,
    private readonly config: ApiConfig,
  ) {}

  private async audit(
    tx: Tx,
    actor: AdminActor,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Prisma.InputJsonObject,
  ) {
    await tx.auditLog.create({
      data: { actorId: actor.userId, action, targetType, targetId, metadata, ip: actor.ip },
    });
  }

  // ───────────── Users ─────────────

  private userRow(user: {
    id: string;
    displayName: string;
    phone: string | null;
    email: string | null;
    createdAt: Date;
    disabledAt: Date | null;
    isSuperAdmin: boolean;
  }): AdminUserRow {
    return {
      id: user.id,
      displayName: user.displayName,
      phone: user.phone,
      email: user.email,
      createdAt: user.createdAt.toISOString(),
      disabled: user.disabledAt !== null,
      superAdmin: user.isSuperAdmin,
    };
  }

  async users(q: string | undefined, cursor: string | undefined) {
    const search = q?.trim();
    const rows = await this.prisma.client.user.findMany({
      where: {
        ...before(cursor),
        ...(search
          ? {
              OR: [
                { displayName: { contains: search, mode: 'insensitive' as const } },
                { phone: { contains: search.replace(/\s+/g, '') } },
                { email: { contains: search.toLowerCase() } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: PAGE + 1,
    });
    const result = page(rows);
    return { users: result.rows.map((row) => this.userRow(row)), nextCursor: result.nextCursor };
  }

  async user(userId: string, now = new Date()): Promise<AdminUserDetail> {
    const db = this.prisma.client;
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return fail(HttpStatus.NOT_FOUND, 'user_not_found');
    const [personal, seats, memberships, projects, storage, usage, credits, payments, balance] =
      await Promise.all([
        db.subscription.findMany({
          where: { userId, status: { notIn: ['CANCELED'] } },
          include: { plan: true },
          orderBy: { currentPeriodEnd: 'desc' },
          take: 10,
        }),
        db.seat.findMany({
          where: { userId, releasedAt: null },
          include: { subscription: { include: { plan: true, organization: true } } },
        }),
        db.membership.findMany({ where: { userId }, include: { organization: true } }),
        db.project.count({ where: { ownerId: userId, deletedAt: null } }),
        db.projectFile.aggregate({
          where: { project: { ownerId: userId } },
          _sum: { sizeBytes: true },
        }),
        db.usageCounter.findFirst({ where: { userId, periodStart: usagePeriodStart(now) } }),
        db.creditEntry.findMany({
          where: { userId },
          include: { createdBy: { select: { displayName: true } } },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
        db.payment.findMany({
          where: { userId },
          include: userInclude,
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
        creditBalanceOf(db, userId),
      ]);
    return {
      user: {
        ...this.userRow(user),
        locale: user.locale,
        emailVerified: user.emailVerifiedAt !== null,
        emailNotifications: user.emailNotifications,
      },
      plans: [
        ...personal.map((row) => ({
          planCode: row.plan.code,
          kind: 'personal' as const,
          status: row.status,
          organizationName: null,
          periodEnd: row.currentPeriodEnd.toISOString(),
        })),
        ...seats.map((seat) => ({
          planCode: seat.subscription.plan.code,
          kind: 'seat' as const,
          status: seat.subscription.status,
          organizationName: seat.subscription.organization?.name ?? null,
          periodEnd: seat.subscription.currentPeriodEnd.toISOString(),
        })),
      ],
      organizations: memberships.map((row) => ({
        id: row.organizationId,
        name: row.organization.name,
        type: row.organization.type,
        role: row.role === 'MEMBER' ? row.kind : row.role,
      })),
      usage: {
        projects,
        storageBytes: Number(storage._sum.sizeBytes ?? 0),
        compilesThisMonth: usage?.compileCount ?? 0,
      },
      creditBalance: balance,
      credits: credits.map((row) => ({
        id: row.id,
        amountXof: row.amountXof,
        reason: row.reason,
        note: row.note,
        reference: row.reference,
        paymentId: row.paymentId,
        createdBy: row.createdBy?.displayName ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      payments: payments.map((row) => this.paymentRow(row)),
      businessTrialUsed: user.businessTrialUsedAt !== null,
    };
  }

  // ───────────── Organizations ─────────────

  private async orgRows(
    organizations: Prisma.OrganizationGetPayload<{
      include: { subscription: { include: { plan: true; planRevision: true } } };
    }>[],
  ): Promise<AdminOrgRow[]> {
    const ids = organizations.map((row) => row.id);
    const memberships = await this.prisma.client.membership.findMany({
      where: { organizationId: { in: ids }, status: 'ACTIVE' },
      include: { user: { select: { displayName: true } } },
    });
    return organizations.map((organization) => {
      const members = memberships.filter((row) => row.organizationId === organization.id);
      const subscription = organization.subscription;
      return {
        id: organization.id,
        name: organization.name,
        type: organization.type,
        ownerName: members.find((row) => row.role === 'OWNER')?.user.displayName ?? null,
        members: members.length,
        subscription: subscription
          ? {
              id: subscription.id,
              planCode: subscription.plan.code,
              status: subscription.status,
              billingPeriod: subscription.billingPeriod,
              seatCount: subscription.seatCount,
              currentPeriodStart: subscription.currentPeriodStart.toISOString(),
              currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
              trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
              planVersion: subscription.planRevision?.version ?? null,
            }
          : null,
        pilotTrial: organization.pilotTrialStartedAt !== null,
        createdAt: organization.createdAt.toISOString(),
      };
    });
  }

  async organizations(q: string | undefined, cursor: string | undefined) {
    const search = q?.trim();
    const rows = await this.prisma.client.organization.findMany({
      where: {
        ...before(cursor),
        ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}),
      },
      include: { subscription: { include: { plan: true, planRevision: true } } },
      orderBy: { createdAt: 'desc' },
      take: PAGE + 1,
    });
    const result = page(rows);
    return { organizations: await this.orgRows(result.rows), nextCursor: result.nextCursor };
  }

  async organization(organizationId: string, now = new Date()): Promise<AdminOrgDetail> {
    const db = this.prisma.client;
    const organization = await db.organization.findUnique({
      where: { id: organizationId },
      include: { subscription: { include: { plan: true, planRevision: true } } },
    });
    if (!organization) return fail(HttpStatus.NOT_FOUND, 'organization_not_found');
    const [row] = await this.orgRows([organization]);
    const subscription = organization.subscription;
    const [members, used] = await Promise.all([
      db.membership.findMany({
        where: { organizationId },
        include: { user: { select: { displayName: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      subscription
        ? db.seat.count({
            where: { subscriptionId: subscription.id, userId: { not: null }, releasedAt: null },
          })
        : Promise.resolve(0),
    ]);
    const started = organization.pilotTrialStartedAt;
    const trialOpen =
      started && subscription?.status === 'TRIALING' && subscription.currentPeriodEnd > now;
    return {
      organization: { ...row!, ifu: organization.ifu },
      seats: { total: subscription?.seatCount ?? 0, used },
      members: members.map((member) => ({
        userId: member.userId,
        displayName: member.user.displayName,
        role: member.role,
        kind: member.kind,
        status: member.status,
      })),
      trial: trialOpen
        ? {
            startedAt: started.toISOString(),
            endsAt: subscription.currentPeriodEnd.toISOString(),
            extendableDays: Math.max(
              0,
              Math.floor(
                (started.getTime() +
                  BUSINESS_TRIAL_MAX_DAYS * DAY_MS -
                  subscription.currentPeriodEnd.getTime()) /
                  DAY_MS,
              ),
            ),
          }
        : null,
    };
  }

  // ───────────── Payments, credits, refunds ─────────────

  private paymentRow(row: PaymentWithUser): AdminPaymentRow {
    return {
      id: row.id,
      userId: row.userId,
      userName: row.user.displayName,
      purpose: row.purpose,
      planCode: row.planCode,
      seats: row.seats,
      amountXof: row.amountXof,
      creditUsedXof: row.creditUsedXof,
      status: row.status,
      receiptNumber: row.receipt?.number ?? null,
      providerTransactionId: row.providerTransactionId,
      duplicateReason: row.duplicateReason,
      createdAt: row.createdAt.toISOString(),
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      refundedAt: row.refundedAt?.toISOString() ?? null,
    };
  }

  async payments(query: { q?: string; status?: AdminPaymentRow['status']; before?: string }) {
    const search = query.q?.trim();
    const receipt = search && /^\d{1,9}$/.test(search) ? Number(search) : null;
    const rows = await this.prisma.client.payment.findMany({
      where: {
        ...before(query.before),
        ...(query.status ? { status: query.status as PaymentWithUser['status'] } : {}),
        ...(search
          ? {
              OR: [
                { providerTransactionId: { contains: search } },
                { user: { displayName: { contains: search, mode: 'insensitive' as const } } },
                { user: { phone: { contains: search.replace(/\s+/g, '') } } },
                ...(receipt !== null ? [{ receipt: { number: receipt } }] : []),
              ],
            }
          : {}),
      },
      include: userInclude,
      orderBy: { createdAt: 'desc' },
      take: PAGE + 1,
    });
    const result = page(rows);
    return {
      payments: result.rows.map((row) => this.paymentRow(row)),
      nextCursor: result.nextCursor,
    };
  }

  private async payer(userId: string) {
    const user = await this.prisma.client.user.findUnique({ where: { id: userId } });
    return user ?? fail(HttpStatus.NOT_FOUND, 'user_not_found');
  }

  /** Adds credit to a payer's balance (deducted automatically from their next payment). */
  async addCredit(actor: AdminActor, userId: string, amountXof: number, note: string) {
    await this.payer(userId);
    await this.locks.runKey(billingLockKey(userId), () =>
      this.prisma.client.$transaction(async (tx) => {
        const entry = await tx.creditEntry.create({
          data: { userId, amountXof, reason: 'ADMIN_CREDIT', note, createdById: actor.userId },
        });
        await this.audit(tx, actor, 'ADMIN_CREDIT_ADDED', 'User', userId, {
          creditEntryId: entry.id,
          amountXof,
          note,
        });
        await this.notifications.notify(tx, [userId], {
          type: 'CREDIT_ADDED',
          payload: { amountXof },
          key: `credit-added:${entry.id}`,
          perUser: false,
          email: 'always',
        });
      }),
    );
    return this.user(userId);
  }

  /**
   * Records a refund made outside the platform: the amount leaves the credit balance (never
   * beyond it); a credited duplicate it pays back is marked refunded.
   */
  async refund(
    actor: AdminActor,
    userId: string,
    input: { amountXof: number; note: string; reference: string; paymentId?: string },
  ) {
    await this.payer(userId);
    await this.locks.runKey(billingLockKey(userId), () =>
      this.prisma.client.$transaction(async (tx) => {
        if ((await creditBalanceOf(tx, userId)) < input.amountXof) {
          fail(HttpStatus.CONFLICT, 'credit_insufficient');
        }
        if (input.paymentId) {
          // A credited duplicate is marked refunded only when the refund covers it.
          const payment = await tx.payment.findFirst({
            where: { id: input.paymentId, userId, status: 'CREDITED' },
          });
          if (!payment) fail(HttpStatus.NOT_FOUND, 'payment_not_found');
          if (input.amountXof < payment!.amountXof) {
            fail(HttpStatus.UNPROCESSABLE_ENTITY, 'refund_below_payment');
          }
          const done = await tx.payment.updateMany({
            where: { id: input.paymentId, userId, status: 'CREDITED' },
            data: { status: 'REFUNDED', refundedAt: new Date() },
          });
          if (!done.count) fail(HttpStatus.NOT_FOUND, 'payment_not_found');
        }
        const entry = await tx.creditEntry.create({
          data: {
            userId,
            amountXof: -input.amountXof,
            reason: 'REFUNDED',
            paymentId: input.paymentId ?? null,
            note: input.note,
            reference: input.reference,
            createdById: actor.userId,
          },
        });
        await this.audit(tx, actor, 'ADMIN_CREDIT_REFUNDED', 'User', userId, {
          creditEntryId: entry.id,
          amountXof: input.amountXof,
          paymentId: input.paymentId ?? null,
          reference: input.reference,
          note: input.note,
        });
        await this.notifications.notify(tx, [userId], {
          type: 'CREDIT_REFUNDED',
          payload: { amountXof: input.amountXof },
          key: `credit-refunded:${entry.id}`,
          perUser: false,
          email: 'always',
        });
      }),
    );
    return this.user(userId);
  }

  // ───────────── BUSINESS pilot trials ─────────────

  /**
   * A 30-day BUSINESS for a pilot university (step 14 decision): a new organization owned by an
   * existing account, once per owner, working as a paid BUSINESS until its end (no grace).
   */
  async startBusinessTrial(
    actor: AdminActor,
    input: { ownerId: string; organizationName: string; seats: number },
    now = new Date(),
  ): Promise<AdminOrgDetail> {
    const db = this.prisma.client;
    const plan = await db.plan.findUniqueOrThrow({ where: { code: 'BUSINESS' } });
    if (
      input.seats < plan.minSeats ||
      (plan.maxSeats !== null && input.seats > plan.maxSeats) ||
      input.seats > this.config.env.BILLING_MAX_SEATS
    ) {
      fail(HttpStatus.UNPROCESSABLE_ENTITY, 'trial_seats_invalid');
    }
    const end = new Date(now.getTime() + BUSINESS_TRIAL_DAYS * DAY_MS);
    const organizationId = await this.locks.runKey(billingLockKey(input.ownerId), () =>
      db.$transaction(async (tx) => {
        const owner = await tx.user.findUnique({ where: { id: input.ownerId } });
        if (!owner || owner.disabledAt) return fail(HttpStatus.NOT_FOUND, 'user_not_found');
        const claimed = await tx.user.updateMany({
          where: { id: owner.id, businessTrialUsedAt: null },
          data: { businessTrialUsedAt: now },
        });
        if (!claimed.count) fail(HttpStatus.CONFLICT, 'business_trial_used');
        const organization = await tx.organization.create({
          data: { type: 'BUSINESS', name: input.organizationName, pilotTrialStartedAt: now },
        });
        await tx.membership.create({
          data: {
            organizationId: organization.id,
            userId: owner.id,
            role: 'OWNER',
            status: 'ACTIVE',
            approvedAt: now,
          },
        });
        const subscription = await tx.subscription.create({
          data: {
            planId: plan.id,
            organizationId: organization.id,
            status: 'TRIALING',
            billingPeriod: 'MONTHLY',
            seatCount: input.seats,
            currentPeriodStart: now,
            currentPeriodEnd: end,
            trialEndsAt: end,
            planRevisionId: await latestRevisionId(tx, plan.id),
          },
        });
        const seat = await tx.seat.create({
          data: { subscriptionId: subscription.id, userId: owner.id, assignedAt: now },
        });
        if (input.seats > 1) {
          await tx.seat.createMany({
            data: Array.from({ length: input.seats - 1 }, () => ({
              subscriptionId: subscription.id,
            })),
          });
        }
        await this.audit(
          tx,
          actor,
          'ADMIN_BUSINESS_TRIAL_STARTED',
          'Organization',
          organization.id,
          {
            ownerId: owner.id,
            name: input.organizationName,
            seats: input.seats,
            endsAt: end.toISOString(),
          },
        );
        await this.audit(tx, actor, 'SUBSCRIPTION_TRIAL_STARTED', 'Subscription', subscription.id, {
          planCode: 'BUSINESS',
          pilot: true,
          endsAt: end.toISOString(),
        });
        await this.audit(tx, actor, 'SEAT_ASSIGNED', 'Seat', seat.id, {
          subscriptionId: subscription.id,
          userId: owner.id,
          owner: true,
        });
        await this.notifications.notify(tx, [owner.id], {
          type: 'BUSINESS_TRIAL_STARTED',
          payload: {
            organizationId: organization.id,
            name: organization.name,
            date: end.toISOString(),
          },
          key: `business-trial-started:${organization.id}`,
          perUser: false,
        });
        return organization.id;
      }),
    );
    // The owner's paid STANDARD pauses while they hold the seat; their limits are applied again.
    await this.seats.applied([input.ownerId]);
    return this.organization(organizationId);
  }

  /** Extends a running pilot trial, up to 60 days in all (step 14 decision). */
  async extendBusinessTrial(
    actor: AdminActor,
    organizationId: string,
    days: number,
    reason: string,
    now = new Date(),
  ): Promise<AdminOrgDetail> {
    const db = this.prisma.client;
    // Under the payer's billing lock, like a payment of the trial (else a renewal paid at the same
    // moment could overwrite the new end).
    const owner = await db.membership.findFirst({
      where: { organizationId, role: 'OWNER', status: 'ACTIVE' },
    });
    await this.locks.runKey(billingLockKey(owner?.userId ?? organizationId), () =>
      this.extendInLock(actor, organizationId, days, reason, now),
    );
    return this.organization(organizationId);
  }

  private async extendInLock(
    actor: AdminActor,
    organizationId: string,
    days: number,
    reason: string,
    now: Date,
  ): Promise<void> {
    const db = this.prisma.client;
    await db.$transaction(async (tx) => {
      const organization = await tx.organization.findUnique({
        where: { id: organizationId },
        include: { subscription: true },
      });
      const subscription = organization?.subscription;
      if (
        !organization?.pilotTrialStartedAt ||
        !subscription ||
        subscription.status !== 'TRIALING' ||
        !isSubscriptionLive(subscription, now)
      ) {
        return fail(HttpStatus.NOT_FOUND, 'business_trial_not_found');
      }
      const end = new Date(subscription.currentPeriodEnd.getTime() + days * DAY_MS);
      const limit = organization.pilotTrialStartedAt.getTime() + BUSINESS_TRIAL_MAX_DAYS * DAY_MS;
      if (end.getTime() > limit) fail(HttpStatus.CONFLICT, 'business_trial_limit');
      const done = await tx.subscription.updateMany({
        where: {
          id: subscription.id,
          status: 'TRIALING',
          currentPeriodEnd: subscription.currentPeriodEnd,
        },
        data: { currentPeriodEnd: end, trialEndsAt: end },
      });
      if (!done.count) fail(HttpStatus.CONFLICT, 'business_trial_not_found');
      await this.audit(tx, actor, 'ADMIN_BUSINESS_TRIAL_EXTENDED', 'Organization', organizationId, {
        subscriptionId: subscription.id,
        days,
        reason,
        from: subscription.currentPeriodEnd.toISOString(),
        to: end.toISOString(),
      });
      const managers = await tx.membership.findMany({
        where: { organizationId, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } },
      });
      await this.notifications.notify(
        tx,
        managers.map((row) => row.userId),
        {
          type: 'BUSINESS_TRIAL_EXTENDED',
          payload: { organizationId, name: organization.name, date: end.toISOString() },
          key: `business-trial-extended:${organizationId}:${end.toISOString()}`,
        },
      );
    });
  }
}
