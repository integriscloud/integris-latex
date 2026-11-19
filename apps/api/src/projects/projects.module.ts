import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { FilesService } from './files.service.js';
import { OwnerLockService } from './owner-lock.service.js';
import { ProjectsController, TemplatesController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';
import { QuotaService } from './quota.service.js';
import { TemplatesService } from './templates.service.js';
import { TrashPurgeService } from './trash-purge.service.js';

@Module({
  imports: [AuthModule],
  controllers: [ProjectsController, TemplatesController],
  providers: [
    FilesService,
    OwnerLockService,
    ProjectsService,
    QuotaService,
    TemplatesService,
    TrashPurgeService,
  ],
  exports: [ProjectsService, QuotaService],
})
export class ProjectsModule {}
