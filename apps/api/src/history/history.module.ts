import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { HistorySchedulerService } from './history-scheduler.service.js';
import { HistoryController } from './history.controller.js';
import { HistoryService } from './history.service.js';

@Module({
  imports: [AuthModule, ProjectsModule],
  controllers: [HistoryController],
  providers: [HistoryService, HistorySchedulerService],
  exports: [HistoryService],
})
export class HistoryModule {}
