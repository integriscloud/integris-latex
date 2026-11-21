import type { Locale, Prisma } from '@integris/db';
import type { BillingNoticeType, NotificationType } from '@integris/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiConfig } from '../config/api-config.js';
import { MAIL_SENDER, type MailSender } from '../mail/mail-sender.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { creditedMail, formatXof } from './billing-messages.js';

/** Payload of a billing notice (`Notification.payload`), read back by GET /api/billing. */
export interface NoticePayload {
  planCode?: string | null;
  amountXof?: number | null;
  receiptNumber?: number | null;
  date?: string | null;
  subscriptionId?: string | null;
  organizationId?: string | null;
  name?: string | null;
}

/**
 * Billing notices: in the application (notification centre and the "Abonnement" banner), by SMS
 * (reminders, docs/spec.md "Renouvellement", with a direct payment link) through the
 * notification queue, and the e-mail of a credited duplicate (always sent). Each one is written
 * at most once per dedupe key.
 */
@Injectable()
export class BillingNotifier {
  private readonly logger = new Logger(BillingNotifier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ApiConfig,
    private readonly notifications: NotificationsService,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
  ) {}

  /**
   * Notice to one user (in the application, plus its SMS for reminder types); false when this key
   * was already used.
   */
  async notice(
    db: Prisma.TransactionClient | null,
    userId: string,
    type: BillingNoticeType | NotificationType,
    payload: NoticePayload,
    dedupeKey: string,
    sms?: (locale: Locale) => string,
  ): Promise<boolean> {
    const fresh = await this.notifications.notify(db, [userId], {
      type,
      payload: payload as Record<string, string | number | null>,
      key: dedupeKey,
      perUser: false,
      sms,
    });
    return fresh.length > 0;
  }

  /** Tells the payer at once that a duplicate payment went to their credit (app + e-mail). */
  async credited(userId: string, paymentId: string, amountXof: number, receiptNumber: number) {
    const db = this.prisma.client;
    await this.notice(
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
