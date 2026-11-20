import type { Locale, Prisma } from '@integris/db';
import type { BillingNoticeType } from '@integris/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiConfig } from '../config/api-config.js';
import { MAIL_SENDER, type MailSender } from '../mail/mail-sender.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { consumeSmsBudget } from '../sms/sms-budget.js';
import { SMS_SENDER, type SmsSender } from '../sms/sms-sender.js';
import { creditedMail, formatXof } from './billing-messages.js';

/** Payload of a billing notice (`Notification.payload`), read back by GET /api/billing. */
export interface NoticePayload {
  planCode?: string | null;
  amountXof?: number | null;
  receiptNumber?: number | null;
  date?: string | null;
  subscriptionId?: string | null;
}

/**
 * Billing notices: in the application (unread notifications shown in the "Abonnement" banner;
 * the notification centre comes with step 14), by SMS (reminders, docs/spec.md "Renouvellement")
 * and by e-mail (credited duplicates). Each one is sent at most once per dedupe key.
 */
@Injectable()
export class BillingNotifier {
  private readonly logger = new Logger(BillingNotifier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ApiConfig,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
  ) {}

  /** In-app notice; false when this key was already used. */
  async inApp(
    db: Prisma.TransactionClient,
    userId: string,
    type: BillingNoticeType,
    payload: NoticePayload,
    dedupeKey: string,
  ): Promise<boolean> {
    const created = await db.notification.createMany({
      data: [
        {
          userId,
          channel: 'IN_APP',
          type,
          payload: payload as Prisma.InputJsonValue,
          dedupeKey: `${dedupeKey}:app`,
        },
      ],
      skipDuplicates: true,
    });
    return created.count > 0;
  }

  /** SMS to a user, once per key, within the platform SMS budget. */
  async smsOnce(
    userId: string,
    type: BillingNoticeType,
    dedupeKey: string,
    text: (locale: Locale) => string,
  ): Promise<boolean> {
    const db = this.prisma.client;
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user?.phone || user.disabledAt) return false;
    const created = await db.notification.createMany({
      data: [{ userId, channel: 'SMS', type, payload: {}, dedupeKey: `${dedupeKey}:sms` }],
      skipDuplicates: true,
    });
    if (!created.count) return false;
    try {
      await consumeSmsBudget(this.redis.client, this.config.env.SMS_DAILY_LIMIT, this.logger);
      await this.sms.send(user.phone, text(user.locale));
      await db.notification.updateMany({
        where: { dedupeKey: `${dedupeKey}:sms` },
        data: { sentAt: new Date() },
      });
      return true;
    } catch (error) {
      // Kept as not sent (sentAt null): reminders are never repeated, a lost one is only logged.
      this.logger.warn({ err: error, userId, type }, 'Billing SMS not sent');
      return false;
    }
  }

  /** Tells the payer at once that a duplicate payment went to their credit (app + e-mail). */
  async credited(userId: string, paymentId: string, amountXof: number, receiptNumber: number) {
    const db = this.prisma.client;
    await this.inApp(
      db,
      userId,
      'PAYMENT_CREDITED',
      { amountXof, receiptNumber },
      `credited:${paymentId}`,
    );
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user?.email || !user.emailVerifiedAt) return;
    try {
      await this.mail.send(
        creditedMail[user.locale](
          user.email,
          formatXof(user.locale, amountXof),
          receiptNumber,
          this.config.env.BILLING_SUPPORT_EMAIL ?? null,
        ),
      );
    } catch (error) {
      this.logger.error({ err: error, paymentId }, 'Credit e-mail not sent');
    }
  }
}
