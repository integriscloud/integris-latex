import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ApiConfig } from '../config/api-config.js';
import { RedisService } from '../redis/redis.service.js';
import { ProjectsService } from './projects.service.js';

/**
 * Erases the projects that have spent 30 days in the trash. Runs in every API process; a Redis
 * lock lets only one of them work per interval.
 */
@Injectable()
export class TrashPurgeService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TrashPurgeService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly projects: ProjectsService,
    private readonly redis: RedisService,
    private readonly config: ApiConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.env.NODE_ENV === 'test') return;
    const interval = this.config.env.TRASH_PURGE_INTERVAL_MINUTES * 60_000;
    this.timer = setInterval(() => void this.run(interval), interval);
    this.timer.unref();
    setTimeout(() => void this.run(interval), 30_000).unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  private async run(interval: number): Promise<void> {
    try {
      const lock = await this.redis.client.set('lock:trash-purge', '1', 'PX', interval, 'NX');
      if (lock !== 'OK') return;
      const erased = await this.projects.purgeTrash();
      if (erased) this.logger.log({ erased }, 'Trash purged');
    } catch (error) {
      this.logger.error({ err: error }, 'Trash purge failed');
    }
  }
}
