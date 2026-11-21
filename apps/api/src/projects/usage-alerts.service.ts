import { type AlertQuota, usageLevel, usagePeriodStart } from '@integris/shared';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ApiConfig } from '../config/api-config.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { QuotaService } from './quota.service.js';

/** Actions in a burst (an editor storing every few seconds) are checked once, after it. */
const DEBOUNCE_MS = 2000;

/**
 * Alerts at 80 % and 100 % of the projects, the storage and the compilations per hour
 * (docs/spec.md, "Alertes de consommation"): an in-app notification (and its e-mail copy if
 * chosen), once per quota, level and month (`Notification.dedupeKey`, so several API processes
 * never send it twice). The banners
 * are computed from the usage on each page. Also records the storage in the monthly counter.
 */
@Injectable()
export class UsageAlertsService implements OnModuleDestroy {
  private readonly logger = new Logger(UsageAlertsService.name);
  private readonly scheduled = new Set<string>();
  private readonly running = new Set<Promise<void>>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly delay: number;

  constructor(
    private readonly quota: QuotaService,
    private readonly notifications: NotificationsService,
    config: ApiConfig,
  ) {
    this.delay = config.env.NODE_ENV === 'test' ? 0 : DEBOUNCE_MS;
  }

  /** Checks the usage of an owner after an action that consumed some; never throws. */
  check(ownerId: string): void {
    if (this.scheduled.has(ownerId)) return;
    this.scheduled.add(ownerId);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.scheduled.delete(ownerId);
      const run: Promise<void> = this.run(ownerId)
        .catch((error: unknown) =>
          this.logger.warn({ err: (error as Error).message, ownerId }, 'Usage alert failed'),
        )
        .finally(() => this.running.delete(run));
      this.running.add(run);
    }, this.delay);
    this.timers.add(timer);
  }

  /** Waits for the checks already scheduled (tests). */
  async idle(): Promise<void> {
    while (this.scheduled.size || this.running.size) {
      await Promise.all(this.running);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearTimeout(timer);
  }

  private async run(ownerId: string): Promise<void> {
    const [quotas, projects, storage, hour] = await Promise.all([
      this.quota.quotas(ownerId),
      this.quota.countProjects(ownerId),
      this.quota.storageUsed(ownerId),
      this.quota.compilesThisHour(ownerId),
    ]);
    await this.quota.recordStorage(ownerId, storage);
    const meters: Record<AlertQuota, { used: number; max: number | null }> = {
      projects: { used: projects, max: quotas.maxProjects },
      storage: { used: Number(storage), max: Number(quotas.storageBytes) },
      compilesPerHour: { used: hour.used, max: quotas.maxCompilesPerHour },
    };
    const month = usagePeriodStart(new Date()).toISOString().slice(0, 7);
    for (const [quota, meter] of Object.entries(meters) as [AlertQuota, typeof meters.projects][]) {
      const level = usageLevel(meter.used, meter.max);
      // Reaching 100 % at once also counts as having passed 80 %.
      const levels = level === 'full' ? ['warn', 'full'] : level === 'warn' ? ['warn'] : [];
      for (const reached of levels) {
        // In the application, and by e-mail if the user chose it (no SMS for quotas).
        await this.notifications.notify(null, [ownerId], {
          type: 'QUOTA_ALERT',
          payload: { quota, level: reached, used: meter.used, max: meter.max, month },
          key: `quota:${ownerId}:${quota}:${reached}:${month}`,
          perUser: false,
        });
      }
    }
  }
}
