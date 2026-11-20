import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { FilesService } from './files.service.js';
import { OwnerLockService } from './owner-lock.service.js';
import { PlanLimitsService } from './plan-limits.service.js';
import { ProjectAuditService } from './project-audit.service.js';
import { ProjectEventsService } from './project-events.service.js';
import { ProjectsController, TemplatesController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';
import { QuotaService } from './quota.service.js';
import { TemplatesService } from './templates.service.js';
import { TrashPurgeService } from './trash-purge.service.js';
import { UsageAlertsService } from './usage-alerts.service.js';
import { UsageController } from './usage.controller.js';
import { ProjectArchiveService } from './zip-export.js';

@Module({
  imports: [AuthModule],
  controllers: [ProjectsController, TemplatesController, UsageController],
  providers: [
    FilesService,
    OwnerLockService,
    PlanLimitsService,
    ProjectAuditService,
    ProjectEventsService,
    ProjectArchiveService,
    ProjectsService,
    QuotaService,
    TemplatesService,
    TrashPurgeService,
    UsageAlertsService,
  ],
  exports: [
    ProjectsService,
    QuotaService,
    ProjectEventsService,
    FilesService,
    ProjectAuditService,
    PlanLimitsService,
    UsageAlertsService,
  ],
})
export class ProjectsModule {}
