import { Global, Module } from '@nestjs/common';
import { ApiConfig } from '../config/api-config.js';
import { RedisService } from '../redis/redis.service.js';
import { LigdicashSmsSender } from './ligdicash-sms-sender.js';
import { LogSmsSender } from './log-sms-sender.js';
import { SMS_SENDER } from './sms-sender.js';

// SMS_PROVIDER: `ligdicash` (sms.ligdicash.io), or `log` in development (refused in production).
@Global()
@Module({
  providers: [
    {
      provide: SMS_SENDER,
      inject: [ApiConfig, RedisService],
      useFactory: (config: ApiConfig, redis: RedisService) =>
        config.env.SMS_PROVIDER === 'ligdicash'
          ? new LigdicashSmsSender(config)
          : new LogSmsSender(redis, config),
    },
  ],
  exports: [SMS_SENDER],
})
export class SmsModule {}
