import { Injectable, Logger } from '@nestjs/common';
import { ApiConfig } from '../config/api-config.js';
import { RedisService } from '../redis/redis.service.js';
import type { SmsSender } from './sms-sender.js';

/** Redis key holding the last SMS sent to a number, read by the end-to-end tests. */
export const devSmsKey = (phoneE164: string) => `dev:sms:${phoneE164}`;

/**
 * Development provider: writes the SMS to the API logs and never sends anything. The
 * environment schema refuses it in production.
 */
@Injectable()
export class LogSmsSender implements SmsSender {
  private readonly logger = new Logger('SMS');

  constructor(
    private readonly redis: RedisService,
    config: ApiConfig,
  ) {
    // Second barrier after the environment schema: never on a production server.
    if (config.env.NODE_ENV === 'production') throw new Error('Fake provider in production');
  }

  async send(phoneE164: string, text: string): Promise<void> {
    this.logger.log(`[fake SMS] to ${phoneE164}: ${text}`);
    await this.redis.client.set(devSmsKey(phoneE164), text, 'EX', 600);
  }
}
