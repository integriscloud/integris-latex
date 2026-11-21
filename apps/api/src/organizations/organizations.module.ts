import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { OwnerLockService } from '../projects/owner-lock.service.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { OrgContextService } from './org-context.service.js';
import { OrgImportService } from './org-import.service.js';
import { OrgInvitationsService } from './org-invitations.service.js';
import {
  OrganizationsController,
  OrgInvitationsController,
  SupervisionsController,
} from './organizations.controller.js';
import { OrganizationsService } from './organizations.service.js';
import { SeatsService } from './seats.service.js';
import { SupervisionService } from './supervision.service.js';

@Module({
  imports: [AuthModule, ProjectsModule, BillingModule],
  controllers: [OrganizationsController, SupervisionsController, OrgInvitationsController],
  providers: [
    OrgContextService,
    OrgImportService,
    OrgInvitationsService,
    OrganizationsService,
    OwnerLockService,
    SeatsService,
    SupervisionService,
  ],
  exports: [SeatsService, OrgContextService],
})
export class OrganizationsModule {}
