import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ApiConfig } from '../config/api-config.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { RedisService } from '../redis/redis.service.js';
import { OwnerLockService } from '../projects/owner-lock.service.js';
import { BillingController } from './billing.controller.js';
import { BillingNotifier } from './billing-notifier.service.js';
import { BillingScheduler } from './billing-scheduler.service.js';
import { BillingService } from './billing.service.js';
import { DevPaymentsController } from './dev-payments.controller.js';
import { LigdicashCallbackController } from './ligdicash-callback.controller.js';
import { LigdicashProvider } from './ligdicash.provider.js';
import { PAYMENT_PROVIDER } from './payment-provider.js';
import { PaymentProcessor } from './payment-processor.service.js';
import { ReceiptsService } from './receipts.service.js';
import { SimulatedProvider } from './simulated.provider.js';
import { SubscriptionPauseService } from './subscription-pause.service.js';

@Module({
  imports: [AuthModule, ProjectsModule],
  controllers: [BillingController, LigdicashCallbackController, DevPaymentsController],
  providers: [
    BillingService,
    BillingNotifier,
    BillingScheduler,
    OwnerLockService,
    PaymentProcessor,
    ReceiptsService,
    SubscriptionPauseService,
    {
      provide: PAYMENT_PROVIDER,
      inject: [ApiConfig, RedisService],
      useFactory: (config: ApiConfig, redis: RedisService) =>
        config.env.PAYMENT_PROVIDER === 'simulated'
          ? new SimulatedProvider(redis, config)
          : new LigdicashProvider(config),
    },
  ],
  exports: [SubscriptionPauseService],
})
export class BillingModule {}
