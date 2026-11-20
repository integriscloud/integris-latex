import { Injectable, Logger } from '@nestjs/common';
import { ApiConfig } from '../config/api-config.js';
import { RedisService } from '../redis/redis.service.js';
import type { Mail, MailSender } from './mail-sender.js';

/** Redis key holding the last e-mail sent to an address, read by the end-to-end tests. */
export const devMailKey = (email: string) => `dev:mail:${email}`;
/** Names and sizes of the files of the last e-mail with attachments sent to an address. */
export const devMailAttachmentsKey = (email: string) => `dev:mail-attachments:${email}`;

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
    const files = (mail.attachments ?? []).map((file) => ({
      filename: file.filename,
      contentType: file.contentType,
      size: file.content.byteLength,
    }));
    const attached = files.map((file) => `\n[attachment] ${file.filename} (${file.size} bytes)`);
    this.logger.log(
      `[fake e-mail] to ${mail.to}: ${mail.subject}\n${mail.text}${attached.join('')}`,
    );
    await this.redis.client.set(devMailKey(mail.to), mail.text, 'EX', 3600);
    if (files.length) {
      await this.redis.client.set(
        devMailAttachmentsKey(mail.to),
        JSON.stringify(files),
        'EX',
        3600,
      );
    }
  }
}
