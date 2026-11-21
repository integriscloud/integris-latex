import { NOTIFICATIONS_QUEUE } from '@integris/shared';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { type Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import { ApiError } from '../common/api-error.js';
import { ApiConfig } from '../config/api-config.js';
import { MAIL_SENDER, type MailSender } from '../mail/mail-sender.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { consumeSmsBudget } from '../sms/sms-budget.js';
import { SmsError, SMS_SENDER, type SmsSender } from '../sms/sms-sender.js';

/** Delay before the first attempt: the transaction that wrote the row has committed by then. */
const FIRST_DELAY_MS = 1000;
const BACKOFF_MS = 30_000;
/** Rows left unsent (Redis down at enqueue time) are queued again by the sweep after this. */
const SWEEP_MS = 5 * 60_000;
const STALE_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

/** SMS of a user today (UTC), for the per-user daily limit. */
export const userSmsKey = (userId: string, day: string) => `notify:sms:${userId}:${day}`;

class NotYetWritten extends Error {}

/**
 * Queue of the SMS and e-mails of the notifications (BullMQ, read by the API only). Each job is
 * one `Notification` row: sent once (job id = row id, and the row keeps `sentAt`), retried with
 * an exponential delay, given up (`failedAt`) after NOTIFY_ATTEMPTS attempts. SMS respect a
 * daily limit per user and the platform SMS budget; beyond them the row is `skipped` and only
 * the in-app notice remains. In tests, jobs wait in memory until `flush()`.
 */
@Injectable()
export class NotificationQueue implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(NotificationQueue.name);
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly testMode: boolean;
  /** Test mode: ids waiting for `flush()`. */
  readonly pending: string[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ApiConfig,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
  ) {
    this.testMode = config.env.NODE_ENV === 'test';
  }

  onApplicationBootstrap(): void {
    if (this.testMode) return;
    const connection = { url: this.config.env.REDIS_URL, maxRetriesPerRequest: null };
    this.queue = new Queue(NOTIFICATIONS_QUEUE, { connection });
    this.queue.on('error', (error) => this.logger.error({ err: error.message }, 'Queue error'));
    this.worker = new Worker(NOTIFICATIONS_QUEUE, (job: Job<{ id: string }>) => this.run(job), {
      connection,
      concurrency: 5,
    });
    this.worker.on('error', (error) => this.logger.error({ err: error.message }, 'Worker error'));
    this.worker.on('failed', (job, error) => {
      if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
      void this.giveUp(job.data.id, error).catch(() => undefined);
    });
    this.sweepTimer = setInterval(() => void this.sweep().catch(() => undefined), SWEEP_MS);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await this.worker?.close();
    await this.queue?.close();
  }

  /** Queues rows to send; never throws (the sweep queues them again if Redis is down). */
  async enqueue(ids: string[]): Promise<void> {
    if (!ids.length) return;
    if (this.testMode) {
      this.pending.push(...ids);
      return;
    }
    try {
      await this.queue!.addBulk(
        ids.map((id) => ({
          name: 'deliver',
          data: { id },
          opts: {
            jobId: id,
            delay: FIRST_DELAY_MS,
            attempts: this.config.env.NOTIFY_ATTEMPTS,
            backoff: { type: 'exponential', delay: BACKOFF_MS },
            removeOnComplete: { age: DAY_MS / 1000 },
            removeOnFail: { age: (7 * DAY_MS) / 1000 },
          },
        })),
      );
    } catch (error) {
      this.logger.error({ err: (error as Error).message }, 'Notifications not queued');
    }
  }

  /** Tests: sends the queued rows now (one attempt each); returns how many were handled. */
  async flush(): Promise<number> {
    const ids = this.pending.splice(0);
    for (const id of ids) {
      try {
        await this.deliver(id);
      } catch (error) {
        await this.giveUp(id, error as Error);
      }
    }
    return ids.length;
  }

  private async run(job: Job<{ id: string }>): Promise<void> {
    try {
      await this.deliver(job.data.id);
    } catch (error) {
      if (error instanceof NotYetWritten) {
        // Rolled back with its transaction: nothing to send, nothing to record.
        if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) return;
        throw error;
      }
      if (error instanceof SmsError && error.permanent) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  }

  /** Sends one SMS or e-mail row unless it was already handled. */
  async deliver(id: string): Promise<void> {
    const db = this.prisma.client;
    const row = await db.notification.findUnique({ where: { id }, include: { user: true } });
    if (!row) throw new NotYetWritten(id);
    if (row.sentAt || row.failedAt || row.skipped) return;
    const user = row.user;
    const skip = (skipped: string) =>
      db.notification.update({ where: { id }, data: { skipped } }).then(() => undefined);
    if (user.disabledAt) return skip('disabled');
    const payload = row.payload as { text?: string; subject?: string };
    if (row.channel === 'SMS') {
      if (!user.phone) return skip('no_phone');
      // Rows written before step 14 carry no text: never sent as an empty SMS.
      if (!payload.text) return skip('no_text');
      if (!(await this.countSms(row.userId, id))) return skip('user_limit');
      try {
        await consumeSmsBudget(this.redis.client, this.config.env.SMS_DAILY_LIMIT, this.logger);
      } catch (error) {
        if (error instanceof ApiError) return skip('budget');
        throw error;
      }
      await this.sms.send(user.phone, payload.text ?? '');
    } else if (row.channel === 'EMAIL') {
      if (!user.email || !user.emailVerifiedAt) return skip('no_email');
      if (!payload.text) return skip('no_text');
      await this.mail.send({
        to: user.email,
        subject: payload.subject ?? '',
        text: payload.text ?? '',
      });
    } else {
      return;
    }
    await db.notification.update({ where: { id }, data: { sentAt: new Date() } });
  }

  /**
   * Counts the SMS of a row once (retries are not counted again); false when the user already
   * received NOTIFY_SMS_PER_USER_PER_DAY SMS today.
   */
  private async countSms(userId: string, id: string): Promise<boolean> {
    const client = this.redis.client;
    const first = await client.set(`notify:counted:${id}`, '1', 'EX', 2 * 86_400, 'NX');
    if (first !== 'OK') return true;
    const key = userSmsKey(userId, new Date().toISOString().slice(0, 10));
    const [[, count]] = (await client
      .multi()
      .incr(key)
      .expire(key, 2 * 86_400)
      .exec()) as [[unknown, number]];
    return count <= this.config.env.NOTIFY_SMS_PER_USER_PER_DAY;
  }

  private async giveUp(id: string, error: Error): Promise<void> {
    if (error instanceof NotYetWritten) return;
    this.logger.warn({ err: error.message, id }, 'Notification not sent');
    await this.prisma.client.notification.updateMany({
      where: { id, sentAt: null, failedAt: null },
      data: { failedAt: new Date() },
    });
  }

  /** Rows written but never queued (Redis unavailable at that moment), from the last 2 days. */
  async sweep(now = new Date()): Promise<void> {
    const lock = await this.redis.client.set('lock:notify-sweep', '1', 'PX', SWEEP_MS, 'NX');
    if (lock !== 'OK') return;
    const rows = await this.prisma.client.notification.findMany({
      where: {
        channel: { in: ['SMS', 'EMAIL'] },
        sentAt: null,
        failedAt: null,
        skipped: null,
        createdAt: {
          lt: new Date(now.getTime() - STALE_MS),
          gt: new Date(now.getTime() - 2 * DAY_MS),
        },
      },
      select: { id: true },
      take: 500,
    });
    const waiting = await Promise.all(rows.map((row) => this.queue!.getJob(row.id)));
    await this.enqueue(rows.filter((_, index) => !waiting[index]).map((row) => row.id));
  }
}
