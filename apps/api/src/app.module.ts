import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module.js';
import { BillingModule } from './billing/billing.module.js';
import { CollabModule } from './collab/collab.module.js';
import { CompileModule } from './compile/compile.module.js';
import { OriginGuard } from './common/origin.guard.js';
import { ConfigModule } from './config/api-config.js';
import { HealthModule } from './health/health.module.js';
import { HistoryModule } from './history/history.module.js';
import { MailModule } from './mail/mail.module.js';
import { PlansModule } from './plans/plans.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { RedisModule } from './redis/redis.module.js';
import { SharingModule } from './sharing/sharing.module.js';
import { SmsModule } from './sms/sms.module.js';
import { StorageModule } from './storage/storage.module.js';
import { SubmissionsModule } from './submissions/submissions.module.js';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
        // Never write session cookies, credentials, codes or passwords to the logs.
        redact: [
          'req.headers.cookie',
          'req.headers.authorization',
          'res.headers["set-cookie"]',
          'req.body',
        ],
      },
    }),
    ConfigModule,
    PrismaModule,
    RedisModule,
    SmsModule,
    MailModule,
    StorageModule,
    HealthModule,
    PlansModule,
    AuthModule,
    ProjectsModule,
    CompileModule,
    HistoryModule,
    CollabModule,
    SharingModule,
    SubmissionsModule,
    BillingModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: OriginGuard }],
})
export class AppModule {}
