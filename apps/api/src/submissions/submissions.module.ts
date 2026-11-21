import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CompileModule } from '../compile/compile.module.js';
import { HistoryModule } from '../history/history.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { SubmissionsController, ToReviewController } from './submissions.controller.js';
import { SubmissionRemindersService } from './submission-reminders.service.js';
import { SubmissionsService } from './submissions.service.js';

@Module({
  imports: [AuthModule, ProjectsModule, HistoryModule, CompileModule],
  controllers: [SubmissionsController, ToReviewController],
  providers: [SubmissionsService, SubmissionRemindersService],
})
export class SubmissionsModule {}
