import { AUTO_VERSION_DELAY_MS, COLLAB_EVENTS_CHANNEL, type CollabEvent } from '@integris/shared';
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service.js';

/** Projects waiting for their automatic version, scored by the time it is due. */
export const HISTORY_DUE_KEY = 'history:due';

/**
 * What happens to a project that others must know: a change for the automatic version (taken
 * 10 minutes after the first change following the previous version), and the events the
 * collaboration server applies to the open documents. Neither ever fails the request.
 */
@Injectable()
export class ProjectEventsService {
  private readonly logger = new Logger(ProjectEventsService.name);

  constructor(private readonly redis: RedisService) {}

  /** The project changed: its next automatic version is due 10 minutes after the first change. */
  async changed(projectId: string): Promise<void> {
    await this.redis.client
      .zadd(HISTORY_DUE_KEY, 'NX', Date.now() + AUTO_VERSION_DELAY_MS, projectId)
      .catch((error: unknown) =>
        this.logger.warn({ err: error, projectId }, 'Change not recorded for the history'),
      );
  }

  async publish(event: CollabEvent): Promise<void> {
    await this.redis.client
      .publish(COLLAB_EVENTS_CHANNEL, JSON.stringify(event))
      .catch((error: unknown) =>
        this.logger.warn({ err: error, event }, 'Collaboration event not published'),
      );
  }
}
