import type { Payment, Prisma, User } from '@integris/db';
import {
  BILLING_NOTICE_TYPES,
  type BillingNotice,
  type BillingOverview,
  type BillingQuote,
  type CheckoutRequest,
  type CheckoutResponse,
  type PaymentStatusView,
  type PaymentSummary,
  type TrialState,
  billingOverviewSchema,
  paymentStatusSchema,
} from '@integris/shared';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { consumeLimit } from '../common/rate-limit.js';
import { ApiConfig } from '../config/api-config.js';
import { latestRevisionId } from '../plans/plan-terms.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { OwnerLockService } from '../projects/owner-lock.service.js';
import { PlanLimitsService } from '../projects/plan-limits.service.js';
import { RedisService } from '../redis/redis.service.js';
import { receiptLabels } from './billing-messages.js';
import {
  creditBalanceOf,
  PURPOSES,
  prepareOrder,
  quoteView,
  type StoredOrder,
} from './billing-orders.js';
import { PAYMENT_PROVIDER, type PaymentProvider, ProviderError } from './payment-provider.js';
import { billingLockKey, PaymentProcessor } from './payment-processor.service.js';
import type { Breakdown } from './receipts.service.js';
import { ReceiptsService } from './receipts.service.js';
import { LIGDICASH_CALLBACK_PATH } from './simulated.provider.js';

const DAY_MS = 86_400_000;
const CHECKOUTS_PER_HOUR = 20;
const RESENDS_PER_HOUR = 5;
const STATUS_CHECK_SECONDS = 10;

type PaymentRow = Payment & {
  receipt: { number: number } | null;
  credits: { amountXof: number; reason: string }[];
  subscription: { organization: { name: string } | null } | null;
};

/**
 * Prices, checkouts and the "Abonnement" page. Every amount comes from the `Plan` table and is
 * computed here (never from the client); a payment is activated only by PaymentProcessor, after
 * LigdiCash confirmed it.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ApiConfig,
    private readonly locks: OwnerLockService,
    private readonly limits: PlanLimitsService,
    private readonly processor: PaymentProcessor,
    private readonly receipts: ReceiptsService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  private get minAmount(): number {
    return this.config.env.LIGDICASH_MIN_AMOUNT;
  }

  private emailRequired(user: User): boolean {
    return !user.email || !user.emailVerifiedAt;
  }

  async quote(user: User, request: CheckoutRequest, now = new Date()): Promise<BillingQuote> {
    const prepared = await prepareOrder(this.prisma.client, user.id, request.order, {
      now,
      minAmount: this.minAmount,
      maxSeats: this.config.env.BILLING_MAX_SEATS,
    });
    return quoteView(prepared, this.minAmount, this.emailRequired(user));
  }

  /**
   * Creates the payment of an order, priced again here, and the LigdiCash invoice. Nothing to pay
   * (credit or discount covers it): the order is applied at once, without LigdiCash.
   */
  async checkout(
    user: User,
    request: CheckoutRequest,
    ip: string | null,
    now = new Date(),
  ): Promise<CheckoutResponse> {
    // Receipts are sent by e-mail only: a verified address is required at the first payment.
    if (this.emailRequired(user)) throw new ApiError(HttpStatus.CONFLICT, 'email_required');
    await consumeLimit(this.redis.client, `rl:checkout:${user.id}`, CHECKOUTS_PER_HOUR, 3600);
    const created = await this.locks.runKey(billingLockKey(user.id), () =>
      this.prisma.client.$transaction(async (tx) => {
        const prepared = await prepareOrder(tx, user.id, request.order, {
          now,
          minAmount: this.minAmount,
          maxSeats: this.config.env.BILLING_MAX_SEATS,
        });
        const { stored, quote } = prepared;
        // The same order still waiting for its payment: the same LigdiCash page again.
        const waiting = await tx.payment.findMany({
          where: {
            userId: user.id,
            status: 'PENDING',
            createdAt: {
              gt: new Date(now.getTime() - this.config.env.PAYMENT_PENDING_HOURS * 3600_000),
            },
          },
          orderBy: { createdAt: 'desc' },
        });
        const same = waiting.find(
          (payment) =>
            (payment.order as unknown as StoredOrder).fingerprint === stored.fingerprint &&
            payment.amountXof === quote.total &&
            payment.checkoutUrl,
        );
        if (same) return { payment: same, reused: true };
        if (
          prepared.promo &&
          waiting.some((payment) => payment.promoCodeId === prepared.promo!.id)
        ) {
          throw new ApiError(HttpStatus.CONFLICT, 'promo_already_used');
        }
        const breakdown: Breakdown = {
          base: quote.base,
          volumeDiscount: quote.volumeDiscount,
          promo: quote.promo,
          promoCode: prepared.promo?.code ?? null,
          promoPercent: prepared.promo?.percentOff ?? null,
          prorationCredit: quote.prorationCredit,
          subtotal: quote.subtotal,
          prorationSurplus: quote.prorationSurplus,
          creditUsed: quote.creditUsed,
          minimumTopUp: quote.minimumTopUp,
          total: quote.total,
          minAmount: this.minAmount,
          periodStart: prepared.periodStart.toISOString(),
          periodEnd: prepared.periodEnd.toISOString(),
          vatRatePercent: this.config.env.VAT_RATE_PERCENT,
        };
        const payment = await tx.payment.create({
          data: {
            userId: user.id,
            subscriptionId: prepared.subscription?.id ?? null,
            purpose: PURPOSES[stored.kind],
            planCode: stored.planCode,
            billingPeriod: stored.period,
            seats: stored.seats,
            amountXof: quote.total,
            creditUsedXof: quote.creditUsed,
            breakdown: breakdown as unknown as Prisma.InputJsonValue,
            order: stored as unknown as Prisma.InputJsonValue,
            promoCodeId: prepared.promo?.id ?? null,
            locale: request.locale,
          },
        });
        // The credit is reserved now (balance checked inside the payer's lock); a failed or
        // expired payment gives it back.
        if (quote.creditUsed > 0) {
          await tx.creditEntry.create({
            data: {
              userId: user.id,
              amountXof: -quote.creditUsed,
              reason: 'USED',
              paymentId: payment.id,
            },
          });
        }
        await tx.auditLog.create({
          data: {
            actorId: user.id,
            action: 'PAYMENT_CREATED',
            targetType: 'Payment',
            targetId: payment.id,
            metadata: {
              purpose: payment.purpose,
              planCode: payment.planCode,
              period: payment.billingPeriod,
              seats: payment.seats,
              amountXof: payment.amountXof,
              creditUsedXof: payment.creditUsedXof,
              promoCode: prepared.promo?.code ?? null,
            } as Prisma.InputJsonValue,
            ip,
          },
        });
        return { payment, reused: false };
      }),
    );
    const { payment } = created;
    if (created.reused) return { paymentId: payment.id, redirectUrl: payment.checkoutUrl };
    if (payment.amountXof === 0) {
      await this.processor.settle(payment.id, null, now);
      return { paymentId: payment.id, redirectUrl: null };
    }
    const web = this.config.env.PUBLIC_WEB_URL;
    const statusPage = `${web}/${request.locale}/app/billing/payments/${payment.id}`;
    const [firstName, ...rest] = user.displayName.trim().split(/\s+/);
    const labels = receiptLabels[request.locale];
    try {
      const invoice = await this.provider.createInvoice({
        paymentId: payment.id,
        amountXof: payment.amountXof,
        description: `Integris LaTeX · ${labels.purposes[payment.purpose]} ${payment.planCode} · ${labels.period[payment.billingPeriod]}`,
        customer: { firstName: firstName ?? '', lastName: rest.join(' '), email: user.email ?? '' },
        returnUrl: statusPage,
        cancelUrl: `${statusPage}?canceled=1`,
        callbackUrl: `${web}/api/${LIGDICASH_CALLBACK_PATH}`,
      });
      await this.prisma.client.payment.update({
        where: { id: payment.id },
        data: { providerToken: invoice.token, checkoutUrl: invoice.url },
      });
      return { paymentId: payment.id, redirectUrl: invoice.url };
    } catch (error) {
      if (!(error instanceof ProviderError)) this.logger.error({ err: error }, 'Invoice failed');
      await this.processor.fail(payment.id, 'not_sent');
      throw new ApiError(HttpStatus.BAD_GATEWAY, 'payment_unavailable');
    }
  }

  /** The 14-day STANDARD trial: once per account, never after a paid STANDARD. */
  async startTrial(user: User, ip: string | null, now = new Date()): Promise<void> {
    await this.locks.runKey(billingLockKey(user.id), () =>
      this.prisma.client.$transaction(async (tx) => {
        const fresh = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
        const plan = await tx.plan.findUnique({ where: { code: 'STANDARD' } });
        if (!plan?.isActive || !plan.trialDays || !(await this.trialAvailable(tx, fresh))) {
          throw new ApiError(HttpStatus.CONFLICT, 'trial_unavailable');
        }
        const end = new Date(now.getTime() + plan.trialDays * DAY_MS);
        const subscription = await tx.subscription.create({
          data: {
            planId: plan.id,
            userId: user.id,
            status: 'TRIALING',
            billingPeriod: 'MONTHLY',
            currentPeriodStart: now,
            currentPeriodEnd: end,
            trialEndsAt: end,
            planRevisionId: await latestRevisionId(tx, plan.id),
          },
        });
        await tx.user.update({ where: { id: user.id }, data: { trialUsedAt: now } });
        await tx.auditLog.create({
          data: {
            actorId: user.id,
            action: 'SUBSCRIPTION_TRIAL_STARTED',
            targetType: 'Subscription',
            targetId: subscription.id,
            metadata: { planCode: 'STANDARD', endsAt: end.toISOString() },
            ip,
          },
        });
      }),
    );
    await this.limits.reconcileQuietly(user.id);
  }

  private async trialAvailable(db: Prisma.TransactionClient, user: User): Promise<boolean> {
    return (await this.trialState(db, user)).state === 'available';
  }

  /** Whether the user can start the STANDARD trial, and why not. */
  private async trialState(
    db: Prisma.TransactionClient,
    user: User,
  ): Promise<{ state: TrialState; endsAt: Date | null }> {
    const [personal, paid] = await Promise.all([
      db.subscription.findMany({
        where: { userId: user.id, status: { in: ['TRIALING', 'ACTIVE', 'GRACE', 'PAUSED'] } },
      }),
      db.payment.count({
        where: { userId: user.id, planCode: 'STANDARD', status: { in: ['SUCCEEDED', 'CREDITED'] } },
      }),
    ]);
    const trial = personal.find((row) => row.status === 'TRIALING');
    if (trial) return { state: 'trialing', endsAt: trial.currentPeriodEnd };
    if (personal.length) return { state: 'subscribed', endsAt: null };
    if (paid) return { state: 'paid', endsAt: null };
    if (user.trialUsedAt) return { state: 'used', endsAt: null };
    return { state: 'available', endsAt: null };
  }

  async overview(user: User, now = new Date()): Promise<BillingOverview> {
    const db = this.prisma.client;
    const owned = await db.membership.findMany({
      where: { userId: user.id, role: 'OWNER', status: 'ACTIVE' },
      select: { organizationId: true },
    });
    const subscriptions = await db.subscription.findMany({
      where: {
        status: { not: 'CANCELED' },
        OR: [
          { userId: user.id },
          { organizationId: { in: owned.map((row) => row.organizationId) } },
        ],
      },
      include: { plan: true, organization: true },
      orderBy: { currentPeriodEnd: 'desc' },
      take: 20,
    });
    const plans = await db.plan.findMany();
    const [payments, creditBalance, trialPlan, notices] = await Promise.all([
      this.payments(user.id),
      creditBalanceOf(db, user.id),
      Promise.resolve(plans.find((plan) => plan.code === 'STANDARD' && plan.isActive) ?? null),
      db.notification.findMany({
        where: {
          userId: user.id,
          channel: 'IN_APP',
          readAt: null,
          type: { in: [...BILLING_NOTICE_TYPES] },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);
    const rows = [];
    for (const subscription of subscriptions) {
      // Expired long ago: no longer shown (renewing it starts a new period anyway).
      if (
        subscription.status === 'EXPIRED' &&
        subscription.currentPeriodEnd.getTime() < now.getTime() - 90 * DAY_MS
      ) {
        continue;
      }
      if (subscription.plan.code === 'FREE') continue;
      const used = await db.seat.count({
        where: { subscriptionId: subscription.id, userId: { not: null }, releasedAt: null },
      });
      const pendingPlan = subscription.pendingPlanId
        ? plans.find((plan) => plan.id === subscription.pendingPlanId)
        : null;
      rows.push({
        id: subscription.id,
        planCode: subscription.plan.code,
        planName: { fr: subscription.plan.nameFr, en: subscription.plan.nameEn },
        status: subscription.status,
        period: subscription.billingPeriod,
        seats: subscription.seatCount,
        seatsUsed: used,
        organization: subscription.organization
          ? { id: subscription.organization.id, name: subscription.organization.name }
          : null,
        currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
        graceEndsAt: subscription.graceEndsAt?.toISOString() ?? null,
        trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
        pausedRemainingDays: subscription.pausedRemainingDays,
        pending: pendingPlan
          ? {
              planCode: pendingPlan.code,
              period: subscription.pendingBillingPeriod ?? subscription.billingPeriod,
              seats: subscription.pendingSeatCount ?? subscription.seatCount,
            }
          : null,
      });
    }
    const trial = await this.trialState(db, user);
    return billingOverviewSchema.parse({
      subscriptions: rows,
      creditBalance,
      payments,
      trial: {
        available: Boolean(trialPlan?.trialDays) && trial.state === 'available',
        days: trialPlan?.trialDays ?? null,
        state: trial.state,
        endsAt: trial.endsAt?.toISOString() ?? null,
      },
      emailVerified: !this.emailRequired(user),
      notices: notices.map((notice): BillingNotice => {
        const payload = (notice.payload ?? {}) as Record<string, unknown>;
        return {
          id: notice.id,
          type: notice.type as BillingNotice['type'],
          createdAt: notice.createdAt.toISOString(),
          planCode: (payload.planCode as BillingNotice['planCode']) ?? null,
          amountXof: (payload.amountXof as number | undefined) ?? null,
          receiptNumber: (payload.receiptNumber as number | undefined) ?? null,
          date: (payload.date as string | undefined) ?? null,
          subscriptionId: (payload.subscriptionId as string | undefined) ?? null,
        };
      }),
      supportEmail: this.config.env.BILLING_SUPPORT_EMAIL ?? null,
      minAmount: this.minAmount,
      maxSeats: this.config.env.BILLING_MAX_SEATS,
    });
  }

  private async payments(userId: string): Promise<PaymentSummary[]> {
    const rows = (await this.prisma.client.payment.findMany({
      where: { userId, status: { not: 'PENDING' } },
      include: {
        receipt: { select: { number: true } },
        credits: { select: { amountXof: true, reason: true } },
        subscription: { select: { organization: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
    })) as PaymentRow[];
    return rows.map((row) => this.summary(row));
  }

  private summary(row: PaymentRow): PaymentSummary {
    const order = row.order as unknown as StoredOrder;
    return {
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      purpose: row.purpose,
      planCode: row.planCode,
      billingPeriod: row.billingPeriod,
      seats: row.seats,
      amountXof: row.amountXof,
      creditUsedXof: row.creditUsedXof,
      status: row.status,
      creditedXof: row.credits
        .filter((credit) => credit.reason !== 'USED' && credit.reason !== 'RELEASED')
        .reduce((sum, credit) => sum + credit.amountXof, 0),
      receiptNumber: row.receipt?.number ?? null,
      organizationName: row.subscription?.organization?.name ?? order.organization?.name ?? null,
    };
  }

  /** Status page after LigdiCash: checks the payment again (at most every few seconds). */
  async paymentStatus(user: User, paymentId: string): Promise<PaymentStatusView> {
    const db = this.prisma.client;
    const found = await db.payment.findUnique({ where: { id: paymentId } });
    if (!found || found.userId !== user.id) {
      throw new ApiError(HttpStatus.NOT_FOUND, 'payment_not_found');
    }
    if (found.status === 'PENDING') {
      const fresh = await this.redis.client.set(
        `rl:payment-check:${paymentId}`,
        '1',
        'EX',
        STATUS_CHECK_SECONDS,
        'NX',
      );
      if (fresh === 'OK') {
        await this.processor.check(paymentId).catch((error: unknown) => {
          this.logger.warn({ err: error, paymentId }, 'Payment status not read');
        });
      }
    }
    const row = (await db.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: {
        receipt: { select: { number: true } },
        credits: { select: { amountXof: true, reason: true } },
        subscription: { select: { organization: { select: { name: true } } } },
      },
    })) as PaymentRow;
    return paymentStatusSchema.parse({
      ...this.summary(row),
      checkoutUrl: row.status === 'PENDING' ? row.checkoutUrl : null,
      supportEmail: this.config.env.BILLING_SUPPORT_EMAIL ?? null,
    });
  }

  /** Sends a receipt again by e-mail (receipts are never downloaded from the app). */
  async resendReceipt(user: User, paymentId: string): Promise<void> {
    const receipt = await this.prisma.client.receipt.findUnique({
      where: { paymentId },
      include: { payment: { select: { userId: true } } },
    });
    if (!receipt || receipt.payment.userId !== user.id) {
      throw new ApiError(HttpStatus.NOT_FOUND, 'payment_not_found');
    }
    await consumeLimit(this.redis.client, `rl:receipt-resend:${user.id}`, RESENDS_PER_HOUR, 3600);
    if (!(await this.receipts.deliver(receipt.id, { resend: true }))) {
      throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'payment_unavailable');
    }
  }

  async readNotices(user: User, ids: string[]): Promise<void> {
    await this.prisma.client.notification.updateMany({
      where: { id: { in: ids }, userId: user.id, readAt: null },
      data: { readAt: new Date() },
    });
  }
}
