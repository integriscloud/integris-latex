import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ApiConfig } from '../config/api-config.js';
import { HISTORY_DUE_KEY } from '../projects/project-events.service.js';
import { RedisService } from '../redis/redis.service.js';
import { HistoryService } from './history.service.js';

// Projects versioned per scan; the others wait for the next one.
const BATCH = 20;
// A version that failed is tried again this much later.
const RETRY_MS = 60_000;

/**
 * Takes the automatic versions that are due. Every API process scans; removing a project from
 * the due set is the claim, so each version is taken by one process only.
 */
@Injectable()
export class HistorySchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(HistorySchedulerService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly history: HistoryService,
    private readonly redis: RedisService,
    private readonly config: ApiConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.run(), this.config.env.HISTORY_SCAN_SECONDS * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** Takes the versions due at `now`; returns how many were taken. */
  async run(now = Date.now()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let taken = 0;
    try {
      const due = await this.redis.client.zrangebyscore(
        HISTORY_DUE_KEY,
        '-inf',
        now,
        'LIMIT',
        0,
        BATCH,
      );
      for (const projectId of due) {
        if ((await this.redis.client.zrem(HISTORY_DUE_KEY, projectId)) !== 1) continue;
        try {
          const version = await this.history.createVersion(projectId, 'AUTO', {
            skipUnchanged: true,
          });
          if (version) taken++;
        } catch (error) {
          this.logger.error({ err: error, projectId }, 'Automatic version failed');
          await this.redis.client.zadd(HISTORY_DUE_KEY, 'NX', now + RETRY_MS, projectId);
        }
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Automatic versions scan failed');
    } finally {
      this.running = false;
    }
    return taken;
  }
}
