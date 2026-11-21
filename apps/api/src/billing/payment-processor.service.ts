import type { Payment, Prisma, Subscription } from '@integris/db';
import { addPeriod, isOrganizationPlan, remainingValue } from '@integris/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiConfig } from '../config/api-config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { OwnerLockService } from '../projects/owner-lock.service.js';
import { PlanLimitsService } from '../projects/plan-limits.service.js';
import { BillingNotifier } from './billing-notifier.service.js';
import { expectedState, payerOf, sameState, type StoredOrder } from './billing-orders.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from './payment-provider.js';
import { type BilledTo, ReceiptsService } from './receipts.service.js';
import { resizeSeats } from './seat-resize.js';
import { SubscriptionPauseService } from './subscription-pause.service.js';

type Tx = Prisma.TransactionClient;

export const billingLockKey = (payerId: string) => `lock:billing:${payerId}`;

/** What a verification found. */
export interface Verification {
  transactionId: string | null;
  raw: Record<string, unknown>;
}

/** Work done after the transaction commits (receipt e-mail, limits, pause, credit notice). */
interface AfterCommit {
  receiptId: string | null;
  credited: { amountXof: number; receiptNumber: number } | null;
  holders: string[];
}

/** Payments closed on our side that LigdiCash may still complete, and for how long. */
const REOPENABLE = ['expired', 'not_completed'];
const REOPEN_DAYS = 7;

function reopenable(payment: Payment, now: Date): boolean {
  return (
    payment.status === 'FAILED' &&
    payment.providerToken !== null &&
    REOPENABLE.includes(payment.duplicateReason ?? '') &&
    payment.createdAt.getTime() > now.getTime() - REOPEN_DAYS * 86_400_000
  );
}

/**
 * Settles payments. A payment is applied only after its status was read from the LigdiCash API
 * with the invoice token saved at its creation (a callback only says "look again"), and only
 * once: the PENDING → SUCCEEDED transition is a conditional update, so concurrent callbacks and
 * checks cannot both apply it. A verified payment that no longer matches the state it was priced
 * on (paid twice, change already applied) is credited to the payer instead (step 11 decision).
 */
@Injectable()
export class PaymentProcessor {
  private readonly logger = new Logger(PaymentProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ApiConfig,
    private readonly locks: OwnerLockService,
    private readonly limits: PlanLimitsService,
    private readonly receipts: ReceiptsService,
    private readonly pause: SubscriptionPauseService,
    private readonly notifier: BillingNotifier,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  /**
   * Reads the status of a payment from the provider and acts on it. Safe to call any number of
   * times, from the callback, the status page or the scheduler.
   */
  async check(paymentId: string, now = new Date()): Promise<Payment | null> {
    const db = this.prisma.client;
    const payment = await db.payment.findUnique({ where: { id: paymentId } });
    if (!payment) return null;
    // Final states never change again, except a payment closed on our side (expired, or refused
    // once by LigdiCash) and paid later on the same LigdiCash page: then it is credited.
    const checkable = payment.status === 'PENDING' || reopenable(payment, now);
    if (!checkable || !payment.providerToken) return payment;
    const status = await this.provider.checkStatus(payment.providerToken);
    this.logger.log(
      {
        paymentId,
        status: status.status,
        reportedXof: status.amountXof,
        expectedXof: payment.amountXof,
        operator: status.operator,
      },
      'LigdiCash status checked',
    );
    await db.payment.update({ where: { id: payment.id }, data: { lastCheckedAt: now } });
    if (status.status === 'pending') return payment;
    if (status.status === 'failed') {
      if (payment.status === 'PENDING') await this.fail(payment.id, 'not_completed', status.raw);
    } else if (status.amountXof !== payment.amountXof) {
      // Never activate on an amount other than the one computed by the server, nor without one.
      this.logger.error(
        { paymentId, expected: payment.amountXof, reported: status.amountXof },
        'Payment amount mismatch',
      );
      if (payment.status === 'PENDING') await this.fail(payment.id, 'amount_mismatch', status.raw);
    } else {
      if (!status.transactionId) this.logger.warn({ paymentId }, 'Paid without a transaction id');
      await this.settle(payment.id, { transactionId: status.transactionId, raw: status.raw }, now);
    }
    return db.payment.findUnique({ where: { id: paymentId } });
  }

  /** Closes a payment that will not be applied, giving back the credit it reserved. */
  async fail(paymentId: string, reason: string, raw: Record<string, unknown> | null = null) {
    const db = this.prisma.client;
    await db.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!payment) return;
      const closed = await tx.payment.updateMany({
        where: { id: paymentId, status: 'PENDING' },
        data: {
          status: 'FAILED',
          duplicateReason: reason,
          ...(raw ? { providerRaw: raw as Prisma.InputJsonValue } : {}),
        },
      });
      if (!closed.count) return;
      await this.releaseCredit(tx, payment);
      await tx.auditLog.create({
        data: {
          actorId: null,
          action: reason === 'expired' ? 'PAYMENT_EXPIRED' : 'PAYMENT_FAILED',
          targetType: 'Payment',
          targetId: paymentId,
          metadata: { reason, amountXof: payment.amountXof, creditUsedXof: payment.creditUsedXof },
        },
      });
    });
  }

  private async releaseCredit(tx: Tx, payment: Payment): Promise<void> {
    if (payment.creditUsedXof <= 0) return;
    await tx.creditEntry.create({
      data: {
        userId: payment.userId,
        amountXof: payment.creditUsedXof,
        reason: 'RELEASED',
        paymentId: payment.id,
      },
    });
    await this.audit(tx, 'CREDIT_RELEASED', 'User', payment.userId, {
      paymentId: payment.id,
      amountXof: payment.creditUsedXof,
    });
  }

  /**
   * Applies (or credits) a payment whose payment was verified with the provider, or that has
   * nothing to pay through it (`verification` null: credit and discounts cover the price).
   */
  async settle(paymentId: string, verification: Verification | null, now = new Date()) {
    const db = this.prisma.client;
    const payment = await db.payment.findUnique({ where: { id: paymentId } });
    if (!payment) return;
    const after = await this.locks.runKey(billingLockKey(payment.userId), () =>
      db.$transaction((tx) => this.settleInTx(tx, paymentId, verification, now)),
    );
    if (after) await this.afterCommit(payment.userId, paymentId, after);
  }

  private async settleInTx(
    tx: Tx,
    paymentId: string,
    verification: Verification | null,
    now: Date,
  ): Promise<AfterCommit | null> {
    const payment = await tx.payment.findUnique({ where: { id: paymentId } });
    if (!payment) return null;
    // Closed on our side, then paid: its reserved credit was already given back.
    const lateAfterExpiry = reopenable(payment, now);
    if (payment.status !== 'PENDING' && !lateAfterExpiry) return null;
    if (verification === null && payment.amountXof > 0) return null;
    const claimed = await tx.payment.updateMany({
      where: { id: paymentId, status: payment.status },
      data: {
        status: 'SUCCEEDED',
        verifiedAt: now,
        providerTransactionId: verification?.transactionId ?? null,
        providerRaw: (verification?.raw ?? { covered: true }) as Prisma.InputJsonValue,
      },
    });
    if (!claimed.count) return null;
    const order = payment.order as unknown as StoredOrder;
    const user = await tx.user.findUniqueOrThrow({ where: { id: payment.userId } });

    const duplicate = lateAfterExpiry
      ? `paid_after_${payment.duplicateReason}`
      : await this.duplicateReason(tx, payment, order);
    if (duplicate) {
      // Paid but not applied: everything the payment carried goes back to the credit balance.
      const credited = payment.amountXof + (lateAfterExpiry ? 0 : payment.creditUsedXof);
      await tx.payment.update({
        where: { id: paymentId },
        data: { status: 'CREDITED', duplicateReason: duplicate },
      });
      if (!lateAfterExpiry) await this.releaseCredit(tx, payment);
      if (payment.amountXof > 0) {
        await tx.creditEntry.create({
          data: {
            userId: payment.userId,
            amountXof: payment.amountXof,
            reason: 'DUPLICATE_PAYMENT',
            paymentId,
          },
        });
      }
      await this.audit(tx, 'PAYMENT_CREDITED', 'Payment', paymentId, {
        reason: duplicate,
        amountXof: payment.amountXof,
        creditedXof: credited,
        transactionId: verification?.transactionId ?? null,
      });
      await this.audit(tx, 'CREDIT_ADDED', 'User', payment.userId, {
        paymentId,
        amountXof: credited,
        reason: 'DUPLICATE_PAYMENT',
      });
      const receipt = await ReceiptsService.issue(tx, payment, this.billedTo(user, order, null));
      return {
        receiptId: receipt.id,
        credited: credited > 0 ? { amountXof: credited, receiptNumber: receipt.number } : null,
        holders: [],
      };
    }

    const { subscription, holders, organization } = await this.apply(tx, payment, order, now);
    await tx.payment.update({
      where: { id: paymentId },
      data: { subscriptionId: subscription.id },
    });
    await this.audit(tx, 'PAYMENT_VERIFIED', 'Payment', paymentId, {
      purpose: payment.purpose,
      planCode: payment.planCode,
      amountXof: payment.amountXof,
      creditUsedXof: payment.creditUsedXof,
      transactionId: verification?.transactionId ?? null,
    });
    if (payment.creditUsedXof > 0) {
      await this.audit(tx, 'CREDIT_USED', 'User', payment.userId, {
        paymentId,
        amountXof: payment.creditUsedXof,
      });
    }
    for (const [reason, amount] of [
      ['MIN_AMOUNT_TOPUP', order.minimumTopUp],
      ['PRORATION_SURPLUS', order.prorationSurplus],
    ] as const) {
      if (amount <= 0) continue;
      await tx.creditEntry.create({
        data: { userId: payment.userId, amountXof: amount, reason, paymentId },
      });
      await this.audit(tx, 'CREDIT_ADDED', 'User', payment.userId, {
        paymentId,
        amountXof: amount,
        reason,
      });
    }
    if (payment.promoCodeId) await this.redeem(tx, payment);
    const receipt = await ReceiptsService.issue(
      tx,
      payment,
      this.billedTo(user, order, organization),
    );
    return { receiptId: receipt.id, credited: null, holders };
  }

  /** Why a verified payment cannot be applied any more, or null when it can. */
  private async duplicateReason(
    tx: Tx,
    payment: Payment,
    order: StoredOrder,
  ): Promise<string | null> {
    if (order.kind === 'NEW') {
      if (!isOrganizationPlan(order.planCode)) {
        const personal = await tx.subscription.findMany({
          where: { userId: payment.userId, status: { in: ['ACTIVE', 'GRACE', 'PAUSED'] } },
        });
        if (personal.length) return 'already_subscribed';
      }
      // The same order paid twice: two payment pages open at the same time (the other payment
      // was verified after this one was created). An order placed again after the first one was
      // settled (subscription ended, second organization) is a new purchase.
      const twins = await tx.payment.findMany({
        where: {
          userId: payment.userId,
          id: { not: payment.id },
          status: 'SUCCEEDED',
          purpose: payment.purpose,
          verifiedAt: { gte: payment.createdAt },
        },
      });
      const fingerprint = order.fingerprint;
      if (
        twins.some((twin) => (twin.order as unknown as StoredOrder).fingerprint === fingerprint)
      ) {
        return 'same_order';
      }
      return null;
    }
    const subscription = order.subscriptionId
      ? await tx.subscription.findUnique({
          where: { id: order.subscriptionId },
          include: { plan: true },
        })
      : null;
    if (!subscription || !order.expected) return 'subscription_changed';
    if (subscription.status === 'PAUSED' || subscription.status === 'CANCELED') {
      return 'subscription_changed';
    }
    // Paid for a state that changed since (another payment applied the same change).
    return sameState(expectedState(subscription), order.expected) ? null : 'subscription_changed';
  }

  /** Applies the order to the subscription; returns it and the users whose plan changed. */
  private async apply(
    tx: Tx,
    payment: Payment,
    order: StoredOrder,
    now: Date,
  ): Promise<{
    subscription: Subscription;
    holders: string[];
    organization: { name: string; ifu: string | null } | null;
  }> {
    const plan = await tx.plan.findUniqueOrThrow({ where: { code: order.planCode } });
    if (order.kind === 'NEW') {
      if (!isOrganizationPlan(plan.code)) {
        const trial = (
          await tx.subscription.findMany({
            where: { userId: payment.userId, status: 'TRIALING', currentPeriodEnd: { gt: now } },
          })
        )[0];
        // Paid during the trial: the paid period starts at the end of the trial.
        const start = trial ? trial.currentPeriodEnd : now;
        const data = {
          planId: plan.id,
          status: 'ACTIVE' as const,
          billingPeriod: order.period,
          seatCount: 1,
          currentPeriodStart: start,
          currentPeriodEnd: addPeriod(start, order.period),
          graceEndsAt: null,
          paidValueXof: order.value,
          paidFromAt: start,
        };
        const subscription = trial
          ? await tx.subscription.update({ where: { id: trial.id }, data })
          : await tx.subscription.create({ data: { ...data, userId: payment.userId } });
        await this.audit(tx, 'SUBSCRIPTION_ACTIVATED', 'Subscription', subscription.id, {
          planCode: plan.code,
          period: order.period,
          paymentId: payment.id,
          fromTrial: Boolean(trial),
        });
        return { subscription, holders: [payment.userId], organization: null };
      }
      const organization = await tx.organization.create({
        data: {
          type: plan.code === 'TEAM' ? 'TEAM' : 'BUSINESS',
          name: order.organization?.name ?? '',
          ifu: order.organization?.ifu ?? null,
        },
      });
      await tx.membership.create({
        data: {
          organizationId: organization.id,
          userId: payment.userId,
          role: 'OWNER',
          status: 'ACTIVE',
          approvedAt: now,
        },
      });
      const subscription = await tx.subscription.create({
        data: {
          planId: plan.id,
          organizationId: organization.id,
          status: 'ACTIVE',
          billingPeriod: order.period,
          seatCount: order.seats,
          currentPeriodStart: now,
          currentPeriodEnd: addPeriod(now, order.period),
          paidValueXof: order.value,
          paidFromAt: now,
        },
      });
      // The owner occupies a seat; the others wait for their member (step 12).
      const owner = await tx.seat.create({
        data: { subscriptionId: subscription.id, userId: payment.userId, assignedAt: now },
      });
      if (order.seats > 1) {
        await tx.seat.createMany({
          data: Array.from({ length: order.seats - 1 }, () => ({
            subscriptionId: subscription.id,
          })),
        });
      }
      await this.audit(tx, 'ORGANIZATION_CREATED', 'Organization', organization.id, {
        type: organization.type,
        paymentId: payment.id,
      });
      await this.audit(tx, 'SUBSCRIPTION_ACTIVATED', 'Subscription', subscription.id, {
        planCode: plan.code,
        period: order.period,
        seats: order.seats,
        paymentId: payment.id,
      });
      await this.audit(tx, 'SEAT_ASSIGNED', 'Seat', owner.id, {
        subscriptionId: subscription.id,
        userId: payment.userId,
        owner: true,
      });
      return {
        subscription,
        holders: [payment.userId],
        organization: { name: organization.name, ifu: organization.ifu },
      };
    }

    const current = await tx.subscription.findUniqueOrThrow({
      where: { id: order.subscriptionId! },
      include: { plan: true, organization: true, seats: { where: { releasedAt: null } } },
    });
    const holders = [
      ...new Set(
        [current.userId, ...current.seats.map((seat) => seat.userId)].filter(
          (id): id is string => id !== null,
        ),
      ),
    ];
    const organization = current.organization
      ? { name: current.organization.name, ifu: current.organization.ifu }
      : null;
    let subscription: Subscription;
    if (order.kind === 'SEATS') {
      subscription = await tx.subscription.update({
        where: { id: current.id },
        data: {
          seatCount: current.seatCount + order.seats,
          paidValueXof: current.paidValueXof + order.value,
        },
      });
      await tx.seat.createMany({
        data: Array.from({ length: order.seats }, () => ({ subscriptionId: current.id })),
      });
      await this.audit(tx, 'SEATS_ADDED', 'Subscription', current.id, {
        added: order.seats,
        seats: subscription.seatCount,
        paymentId: payment.id,
      });
    } else if (order.kind === 'UPGRADE') {
      subscription = await tx.subscription.update({
        where: { id: current.id },
        data: {
          planId: plan.id,
          status: 'ACTIVE',
          billingPeriod: order.period,
          seatCount: order.seats,
          currentPeriodStart: now,
          currentPeriodEnd: addPeriod(now, order.period),
          graceEndsAt: null,
          paidValueXof: order.value,
          paidFromAt: now,
        },
      });
      if (current.organization && plan.code !== current.plan.code) {
        await tx.organization.update({
          where: { id: current.organization.id },
          data: { type: plan.code === 'TEAM' ? 'TEAM' : 'BUSINESS' },
        });
      }
      await this.resizeSeats(tx, current.id, order.seats);
      await this.audit(tx, 'SUBSCRIPTION_UPGRADED', 'Subscription', current.id, {
        from: {
          planCode: current.plan.code,
          period: current.billingPeriod,
          seats: current.seatCount,
        },
        to: { planCode: plan.code, period: order.period, seats: order.seats },
        paymentId: payment.id,
      });
    } else {
      // Renewal: from the period end while active or in grace, from now after the return to Free.
      const start = current.status === 'EXPIRED' ? now : current.currentPeriodEnd;
      const changed =
        plan.id !== current.planId ||
        order.period !== current.billingPeriod ||
        order.seats !== current.seatCount;
      if (changed && start > now) {
        // A lower plan, another period or fewer seats: paid now, applied at the period end.
        subscription = await tx.subscription.update({
          where: { id: current.id },
          data: {
            pendingPlanId: plan.id,
            pendingBillingPeriod: order.period,
            pendingSeatCount: order.seats,
            pendingValueXof: order.value,
          },
        });
      } else {
        const extension = start >= now;
        subscription = await tx.subscription.update({
          where: { id: current.id },
          data: {
            planId: plan.id,
            status: 'ACTIVE',
            billingPeriod: order.period,
            seatCount: order.seats,
            currentPeriodStart: start,
            currentPeriodEnd: addPeriod(start, order.period),
            graceEndsAt: null,
            // Value of the paid time: what is left of the current period, plus the new one.
            paidValueXof: extension
              ? remainingValue(
                  {
                    periodEnd: current.currentPeriodEnd,
                    period: current.billingPeriod,
                    paidValueXof: current.paidValueXof,
                    paidFrom: current.paidFromAt,
                  },
                  now,
                ) + order.value
              : order.value,
            paidFromAt: extension ? now : start,
          },
        });
        if (current.organization && plan.code !== current.plan.code) {
          await tx.organization.update({
            where: { id: current.organization.id },
            data: { type: plan.code === 'TEAM' ? 'TEAM' : 'BUSINESS' },
          });
        }
        await this.resizeSeats(tx, current.id, order.seats);
      }
      await this.audit(tx, 'SUBSCRIPTION_RENEWED', 'Subscription', current.id, {
        planCode: plan.code,
        period: order.period,
        seats: order.seats,
        startsAt: start.toISOString(),
        atPeriodEnd: changed && start > now,
        paymentId: payment.id,
      });
    }
    return { subscription, holders, organization };
  }

  /** Adds seats, or removes seats nobody holds nor reserves (see seat-resize.ts). */
  private async resizeSeats(tx: Tx, subscriptionId: string, wanted: number) {
    const { removed } = await resizeSeats(tx, subscriptionId, wanted);
    if (removed.length) {
      await this.audit(tx, 'SEATS_REMOVED', 'Subscription', subscriptionId, { seatIds: removed });
    }
  }

  /** Records the use of the promo code (once per account; the price was already discounted). */
  private async redeem(tx: Tx, payment: Payment): Promise<void> {
    const promoCodeId = payment.promoCodeId!;
    const used = await tx.promoRedemption.findFirst({
      where: { promoCodeId, userId: payment.userId },
    });
    if (used) {
      // Two payments of one account with the same code, settled together: the price was already
      // discounted; recorded for the back-office.
      await this.audit(tx, 'PROMO_OVER_LIMIT', 'Payment', payment.id, {
        promoCodeId,
        reason: 'account',
      });
      return;
    }
    await tx.promoRedemption.create({
      data: { promoCodeId, userId: payment.userId, paymentId: payment.id },
    });
    const promo = await tx.promoCode.findUniqueOrThrow({ where: { id: promoCodeId } });
    const counted = await tx.promoCode.updateMany({
      where: {
        id: promoCodeId,
        ...(promo.maxRedemptions === null ? {} : { redemptionCount: { lt: promo.maxRedemptions } }),
      },
      data: { redemptionCount: { increment: 1 } },
    });
    await this.audit(
      tx,
      counted.count ? 'PROMO_REDEEMED' : 'PROMO_OVER_LIMIT',
      'Payment',
      payment.id,
      {
        promoCodeId,
        code: promo.code,
        percentOff: promo.percentOff,
      },
    );
  }

  private billedTo(
    user: { displayName: string; email: string | null; emailVerifiedAt: Date | null },
    order: StoredOrder,
    organization: { name: string; ifu: string | null } | null,
  ): BilledTo {
    return {
      name: user.displayName,
      email: user.emailVerifiedAt ? user.email : null,
      organization: organization?.name ?? order.organization?.name ?? null,
      ifu: organization?.ifu ?? order.organization?.ifu ?? null,
    };
  }

  private audit(
    tx: Tx,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown>,
  ) {
    return tx.auditLog.create({
      data: {
        actorId: null,
        action,
        targetType,
        targetId,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }

  private async afterCommit(payerId: string, paymentId: string, after: AfterCommit) {
    try {
      if (after.credited) {
        await this.notifier.credited(
          payerId,
          paymentId,
          after.credited.amountXof,
          after.credited.receiptNumber,
        );
      }
      for (const userId of after.holders) {
        await this.pause.sync(userId);
        await this.limits.reconcileQuietly(userId);
      }
      if (after.receiptId) await this.receipts.deliver(after.receiptId);
    } catch (error) {
      // The payment is settled; the scheduler sends the receipt again and sweeps the pauses.
      this.logger.error({ err: error, paymentId }, 'After-payment work failed');
    }
  }

  /** Pending payments: checked again (lost callbacks), closed after PAYMENT_PENDING_HOURS. */
  async sweepPending(now = new Date()): Promise<void> {
    const db = this.prisma.client;
    const hours = this.config.env.PAYMENT_PENDING_HOURS;
    const pending = await db.payment.findMany({
      where: {
        status: 'PENDING',
        providerToken: { not: null },
        OR: [
          { lastCheckedAt: null },
          { lastCheckedAt: { lte: new Date(now.getTime() - 5 * 60_000) } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    for (const payment of pending) {
      try {
        const checked = await this.check(payment.id, now);
        const stale = payment.createdAt.getTime() <= now.getTime() - hours * 3600_000;
        if (checked?.status === 'PENDING' && stale) await this.fail(payment.id, 'expired');
      } catch (error) {
        this.logger.warn({ err: error, paymentId: payment.id }, 'Pending payment not checked');
      }
    }
    // Closed on our side but maybe paid later on the same LigdiCash page: checked hourly.
    const closed = await db.payment.findMany({
      where: {
        status: 'FAILED',
        providerToken: { not: null },
        duplicateReason: { in: REOPENABLE },
        createdAt: { gt: new Date(now.getTime() - REOPEN_DAYS * 86_400_000) },
        OR: [
          { lastCheckedAt: null },
          { lastCheckedAt: { lte: new Date(now.getTime() - 3600_000) } },
        ],
      },
      take: 100,
    });
    for (const payment of closed) {
      await this.check(payment.id, now).catch((error: unknown) =>
        this.logger.warn({ err: error, paymentId: payment.id }, 'Closed payment not checked'),
      );
    }
    // Payments never sent to LigdiCash (invoice refused or API down at creation).
    const orphans = await db.payment.findMany({
      where: {
        status: 'PENDING',
        providerToken: null,
        amountXof: { gt: 0 },
        createdAt: { lte: new Date(now.getTime() - 3600_000) },
      },
      take: 100,
    });
    for (const payment of orphans) await this.fail(payment.id, 'not_sent');
  }

  /** The payer of a subscription (for reminders). */
  payerOf(subscription: Subscription) {
    return payerOf(this.prisma.client, subscription);
  }
}
