import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { NotificationQueue } from './notification-queue.service.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

/** Notifications of every module: in-app centre, SMS and e-mail queue (step 14). */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationQueue],
  exports: [NotificationsService, NotificationQueue],
})
export class NotificationsModule {}
