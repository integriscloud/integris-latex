import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CompileModule } from '../compile/compile.module.js';
import { HistoryModule } from '../history/history.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import {
  ExamPapersController,
  OrgPrintController,
  PrintRequestsController,
} from './exam-papers.controller.js';
import { ExamPapersService } from './exam-papers.service.js';
import { OrgTemplatesService } from './org-templates.service.js';
import { PrintAccessService } from './print-access.service.js';
import { SecretariatService } from './secretariat.service.js';

/** Exam papers and secretariat (docs/spec.md, "Devoirs et secrétariat"), official templates. */
@Module({
  imports: [AuthModule, ProjectsModule, HistoryModule, CompileModule, OrganizationsModule],
  controllers: [ExamPapersController, PrintRequestsController, OrgPrintController],
  providers: [ExamPapersService, OrgTemplatesService, PrintAccessService, SecretariatService],
})
export class ExamPapersModule {}
