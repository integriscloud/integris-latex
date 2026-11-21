import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { OwnerLockService } from '../projects/owner-lock.service.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { AdminAccountsService } from './admin-accounts.service.js';
import { AdminCatalogService } from './admin-catalog.service.js';
import { AdminController } from './admin.controller.js';
import { AdminAuditInterceptor, SuperAdminGuard } from './admin.guard.js';
import { AdminPlansService } from './admin-plans.service.js';
import { AdminStatsService } from './admin-stats.service.js';

/** Back-office of Integris (step 14). */
@Module({
  imports: [AuthModule, ProjectsModule, OrganizationsModule],
  controllers: [AdminController],
  providers: [
    AdminAccountsService,
    AdminAuditInterceptor,
    AdminCatalogService,
    AdminPlansService,
    AdminStatsService,
    OwnerLockService,
    SuperAdminGuard,
  ],
})
export class AdminModule {}
