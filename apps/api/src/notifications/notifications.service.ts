import { type NotificationChannel, Prisma, type User } from '@integris/db';
import {
  type Locale,
  NOTIFICATION_TYPES,
  type NotificationType,
  SMS_NOTIFICATION_TYPES,
} from '@integris/shared';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApiConfig } from '../config/api-config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { notificationMail, notificationSms, type Payload } from './notification-messages.js';
import { NotificationQueue } from './notification-queue.service.js';

type Db = Prisma.TransactionClient;

export interface NotifyInput {
  type: NotificationType;
  /** Shown in the centre (the web app builds the text from it). */
  payload: Payload;
  /**
   * Written at most once per key: the same key never notifies a user twice. Several users: the
   * user id is appended unless `perUser` is false (keys that already name their only user).
   */
  key?: string;
  perUser?: boolean;
  /** SMS text of this notice (billing reminders and their payment link), else the default one. */
  sms?: (locale: Locale) => string;
  /** false: no SMS even for an SMS type (members already told by another notice). */
  sendSms?: boolean;
  /** 'always': the e-mail copy is sent whatever the preferences (credits and refunds). */
  email?: 'always';
}

/**
 * Notifications (docs/spec.md, "décisions étape 14"): every notice is written in the application
 * first; its SMS (types of SMS_NOTIFICATION_TYPES) and its e-mail copy (categories the user
 * chose, verified address only) are written as rows of their own and sent by the notification
 * queue, with retries. Called inside the transaction of the action: a row rolled back with it is
 * simply never found by the queue.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: NotificationQueue,
    private readonly config: ApiConfig,
  ) {}

  /** Link of the notification centre, sent in SMS and e-mails. */
  centreLink(locale: Locale): string {
    return `${this.config.env.PUBLIC_WEB_URL}/${locale}/app/notifications`;
  }

  /** Notifies users; returns those for whom the in-app notice is new (not seen with this key). */
  async notify(db: Db | null, userIds: readonly string[], input: NotifyInput): Promise<string[]> {
    const client = db ?? this.prisma.client;
    const unique = [...new Set(userIds)];
    if (!unique.length) return [];
    const users = await client.user.findMany({ where: { id: { in: unique } } });
    const keyOf = (userId: string, channel: string) =>
      input.key ? `${input.key}${input.perUser === false ? '' : `:${userId}`}:${channel}` : null;
    const keys = users.flatMap((user) =>
      ['app', 'sms', 'mail'].map((channel) => keyOf(user.id, channel)),
    );
    const known = new Set(
      input.key
        ? (
            await client.notification.findMany({
              where: { dedupeKey: { in: keys.filter((key): key is string => key !== null) } },
              select: { dedupeKey: true },
            })
          ).map((row) => row.dedupeKey)
        : [],
    );
    const rows: Prisma.NotificationCreateManyInput[] = [];
    const fresh: string[] = [];
    const sms =
      input.sendSms !== false && SMS_NOTIFICATION_TYPES.some((type) => type === input.type);
    const category = NOTIFICATION_TYPES[input.type];
    for (const user of users) {
      if (user.disabledAt) continue;
      const row = (channel: NotificationChannel, suffix: string, payload: Payload) => {
        const dedupeKey = keyOf(user.id, suffix);
        if (dedupeKey && known.has(dedupeKey)) return false;
        rows.push({
          id: randomUUID(),
          userId: user.id,
          channel,
          type: input.type,
          payload: payload as Prisma.InputJsonObject,
          dedupeKey,
        });
        return true;
      };
      if (!row('IN_APP', 'app', input.payload)) continue;
      fresh.push(user.id);
      const link = this.centreLink(user.locale);
      if (sms && user.phone) {
        const text = input.sms?.(user.locale) ?? notificationSms(input.type, user.locale, link);
        if (text) row('SMS', 'sms', { text });
      }
      if (this.wantsMail(user, category, input.email === 'always')) {
        row('EMAIL', 'mail', notificationMail(input.type, input.payload, user.locale, link));
      }
    }
    if (!rows.length) return [];
    // Concurrent notices with the same key: the second insert of a key is skipped.
    await client.notification.createMany({ data: rows, skipDuplicates: true });
    await this.queue.enqueue(
      rows.filter((row) => row.channel !== 'IN_APP').map((row) => row.id as string),
    );
    return fresh;
  }

  private wantsMail(
    user: User,
    category: (typeof NOTIFICATION_TYPES)[NotificationType],
    always: boolean,
  ) {
    return Boolean(
      user.email && user.emailVerifiedAt && (always || user.emailNotifications.includes(category)),
    );
  }
}
