import { DUE_REMINDER_DAYS } from '@integris/shared';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ApiConfig } from '../config/api-config.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';

const DAY_MS = 86_400_000;
const SWEEP_MS = 10 * 60_000;

/**
 * "Échéance dans 2 jours" (docs/spec.md, "Notifications"): 2 days before the deadline of a
 * submission that is not validated, its author and the supervisors (role Encadrant) among its
 * reviewers are told in the application and by SMS, once per deadline (a new deadline is told
 * again). A draft has not reached its reviewers yet: only its author is told.
 */
@Injectable()
export class SubmissionRemindersService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SubmissionRemindersService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly notifications: NotificationsService,
    private readonly config: ApiConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.run(), SWEEP_MS).unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  private async run(): Promise<void> {
    try {
      const lock = await this.redis.client.set('lock:due-reminders', '1', 'PX', SWEEP_MS, 'NX');
      if (lock === 'OK') await this.remind();
    } catch (error) {
      this.logger.error({ err: (error as Error).message }, 'Deadline reminders failed');
    }
  }

  async remind(now = new Date()): Promise<number> {
    const db = this.prisma.client;
    const due = await db.submission.findMany({
      where: {
        status: { not: 'VALIDATED' },
        dueAt: { gt: now, lte: new Date(now.getTime() + DUE_REMINDER_DAYS * DAY_MS) },
        project: { deletedAt: null },
      },
      include: { reviewers: true },
      take: 500,
    });
    let told = 0;
    for (const submission of due) {
      const reviewerIds = submission.reviewers.map((row) => row.reviewerId);
      const supervisors =
        submission.status === 'DRAFT' || !reviewerIds.length
          ? []
          : await db.projectMember.findMany({
              where: {
                projectId: submission.projectId,
                userId: { in: reviewerIds },
                role: 'SUPERVISOR',
              },
            });
      const people = [submission.authorId, ...supervisors.map((member) => member.userId)];
      const fresh = await this.notifications.notify(db, people, {
        type: 'SUBMISSION_DUE_SOON',
        payload: {
          submissionId: submission.id,
          projectId: submission.projectId,
          title: submission.title,
          dueAt: submission.dueAt!.toISOString(),
        },
        key: `submission-due:${submission.id}:${submission.dueAt!.toISOString()}`,
      });
      told += fresh.length;
    }
    return told;
  }
}
