import type { AdminStats } from '@integris/shared';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { isSubscriptionLive } from '../projects/quota.service.js';

const MONTHS = 12;

const monthOf = (date: Date) => date.toISOString().slice(0, 7);

/**
 * Statistics of the back-office (docs/spec.md, "décisions étape 14"): accounts created, paying
 * accounts and organizations, revenue (verified payments minus refunds) and compilations, per
 * month over the last 12 months, and totals. Amounts are integer XOF.
 */
@Injectable()
export class AdminStatsService {
  constructor(private readonly prisma: PrismaService) {}

  async stats(now = new Date()): Promise<AdminStats> {
    const db = this.prisma.client;
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (MONTHS - 1), 1));
    const [users, signups, live, payments, refunds, usage, allPayments, allRefunds, allUsage] =
      await Promise.all([
        db.user.count(),
        db.user.findMany({ where: { createdAt: { gte: from } }, select: { createdAt: true } }),
        db.subscription.findMany({
          where: {
            status: { in: ['TRIALING', 'ACTIVE', 'GRACE'] },
            plan: { code: { not: 'FREE' } },
          },
          select: {
            userId: true,
            organizationId: true,
            status: true,
            currentPeriodEnd: true,
            graceEndsAt: true,
          },
        }),
        db.payment.findMany({
          where: {
            verifiedAt: { gte: from },
            status: { in: ['SUCCEEDED', 'CREDITED', 'REFUNDED'] },
          },
          select: { verifiedAt: true, amountXof: true },
        }),
        db.creditEntry.findMany({
          where: { reason: 'REFUNDED', createdAt: { gte: from } },
          select: { createdAt: true, amountXof: true },
        }),
        db.usageCounter.groupBy({
          by: ['periodStart'],
          where: { periodStart: { gte: from } },
          _sum: { compileCount: true, compileSeconds: true },
        }),
        db.payment.aggregate({
          where: {
            status: { in: ['SUCCEEDED', 'CREDITED', 'REFUNDED'] },
            verifiedAt: { not: null },
          },
          _sum: { amountXof: true },
        }),
        db.creditEntry.aggregate({ where: { reason: 'REFUNDED' }, _sum: { amountXof: true } }),
        db.usageCounter.aggregate({ _sum: { compileCount: true } }),
      ]);
    const months = Array.from({ length: MONTHS }, (_, index) => {
      const month = monthOf(
        new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + index, 1)),
      );
      const counted = usage.filter((row) => monthOf(row.periodStart) === month);
      return {
        month,
        signups: signups.filter((row) => monthOf(row.createdAt) === month).length,
        // Refund entries are negative amounts of the credit ledger.
        revenueXof:
          payments
            .filter((row) => monthOf(row.verifiedAt!) === month)
            .reduce((sum, row) => sum + row.amountXof, 0) +
          refunds
            .filter((row) => monthOf(row.createdAt) === month)
            .reduce((sum, row) => sum + row.amountXof, 0),
        compilations: counted.reduce((sum, row) => sum + (row._sum.compileCount ?? 0), 0),
        compileMinutes: Math.round(
          counted.reduce((sum, row) => sum + (row._sum.compileSeconds ?? 0), 0) / 60,
        ),
      };
    });
    const paid = live.filter((row) => row.status !== 'TRIALING' && isSubscriptionLive(row, now));
    return {
      totals: {
        users,
        payingUsers: new Set(paid.flatMap((row) => (row.userId ? [row.userId] : []))).size,
        payingOrganizations: paid.filter((row) => row.organizationId !== null).length,
        trials: live.filter((row) => row.status === 'TRIALING' && isSubscriptionLive(row, now))
          .length,
        revenueXof: (allPayments._sum.amountXof ?? 0) + (allRefunds._sum.amountXof ?? 0),
        compilations: allUsage._sum.compileCount ?? 0,
      },
      months,
    };
  }
}
