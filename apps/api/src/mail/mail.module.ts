import { Global, Module } from '@nestjs/common';
import { ApiConfig } from '../config/api-config.js';
import { RedisService } from '../redis/redis.service.js';
import { LogMailSender } from './log-mail-sender.js';
import { MAIL_SENDER } from './mail-sender.js';
import { SmtpMailSender } from './smtp-mail-sender.js';

// MAIL_PROVIDER: `smtp` (the SMTP server of Integris), or `log` in development.
@Global()
@Module({
  providers: [
    {
      provide: MAIL_SENDER,
      inject: [ApiConfig, RedisService],
      useFactory: (config: ApiConfig, redis: RedisService) =>
        config.env.MAIL_PROVIDER === 'smtp'
          ? new SmtpMailSender(config)
          : new LogMailSender(redis, config),
    },
  ],
  exports: [MAIL_SENDER],
})
export class MailModule {}
