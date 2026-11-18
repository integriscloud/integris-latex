import { Injectable, Logger } from '@nestjs/common';
import { ApiConfig } from '../config/api-config.js';
import { RedisService } from '../redis/redis.service.js';
import type { Mail, MailSender } from './mail-sender.js';

/** Redis key holding the last e-mail sent to an address, read by the end-to-end tests. */
export const devMailKey = (email: string) => `dev:mail:${email}`;

/** Development provider: writes the e-mail to the API logs and never sends anything. */
@Injectable()
export class LogMailSender implements MailSender {
  private readonly logger = new Logger('Mail');

  constructor(
    private readonly redis: RedisService,
    config: ApiConfig,
  ) {
    // Second barrier after the environment schema: never on a production server.
    if (config.env.NODE_ENV === 'production') throw new Error('Fake provider in production');
  }

  async send(mail: Mail): Promise<void> {
    this.logger.log(`[fake e-mail] to ${mail.to}: ${mail.subject}\n${mail.text}`);
    await this.redis.client.set(devMailKey(mail.to), mail.text, 'EX', 3600);
  }
}
