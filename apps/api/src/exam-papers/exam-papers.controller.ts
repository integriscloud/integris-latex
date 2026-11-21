import {
  coeditorSchema,
  confirmPrintedSchema,
  createExamPaperSchema,
  type ExamPaperDetail,
  type ExamPaperList,
  handOverSchema,
  type OrgPrintOverview,
  type OrgTemplateView,
  orgTemplateQuerySchema,
  type PrintEventView,
  type PrintLink,
  type PrintRequestPage,
  type PrintRequestView,
  type ProjectSummary,
  type SecretariatQueue,
  sendPrintSchema,
  updateOrgTemplateSchema,
  updatePrintSchema,
} from '@integris/shared';
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { z } from 'zod';
import { Auth, type AuthContext, AuthGuard } from '../auth/auth.guard.js';
import { readRawBody } from '../common/raw-body.js';
import { ipOf } from '../common/request-ip.js';
import { ApiZodBody, ZodBody, ZodQuery } from '../common/zod-body.js';
import { ApiConfig } from '../config/api-config.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ExamPapersService } from './exam-papers.service.js';
import { OrgTemplatesService } from './org-templates.service.js';
import { SecretariatService } from './secretariat.service.js';

const actorOf = (auth: AuthContext, request: Request) => ({
  userId: auth.user.id,
  ip: ipOf(request),
});

/** "Mes devoirs": exam papers of a teacher, their co-editors and their sends (BUSINESS). */
@ApiTags('exam-papers')
@Controller('exam-papers')
@UseGuards(AuthGuard)
export class ExamPapersController {
  constructor(private readonly papers: ExamPapersService) {}

  @Get()
  list(@Auth() auth: AuthContext): Promise<ExamPaperList> {
    return this.papers.list(auth.user.id);
  }

  @Post()
  @ApiZodBody(createExamPaperSchema)
  create(
    @Auth() auth: AuthContext,
    @ZodBody(createExamPaperSchema) body: z.infer<typeof createExamPaperSchema>,
  ): Promise<ProjectSummary> {
    return this.papers.create(auth.user, body.name);
  }

  @Get(':id')
  detail(@Auth() auth: AuthContext, @Param('id') id: string): Promise<ExamPaperDetail> {
    return this.papers.detail(auth.user.id, id);
  }

  /** Journal of the exam paper: requests and co-editors. */
  @Get(':id/journal')
  async journal(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<{ events: PrintEventView[] }> {
    return { events: await this.papers.journal(auth.user.id, id) };
  }

  /** Sends the subject to the secretariat (owner only): frozen, compiled, then requested. */
  @Post(':id/send')
  @HttpCode(200)
  @ApiZodBody(sendPrintSchema)
  send(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(sendPrintSchema) body: z.infer<typeof sendPrintSchema>,
    @Req() request: Request,
  ): Promise<ExamPaperDetail> {
    return this.papers.send(actorOf(auth, request), id, body);
  }

  @Post(':id/coeditors')
  @HttpCode(200)
  @ApiZodBody(coeditorSchema)
  addCoeditor(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(coeditorSchema) body: z.infer<typeof coeditorSchema>,
    @Req() request: Request,
  ): Promise<ExamPaperDetail> {
    return this.papers.addCoeditor(actorOf(auth, request), id, body.userId);
  }

  @Delete(':id/coeditors/:userId')
  removeCoeditor(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Req() request: Request,
  ): Promise<ExamPaperDetail> {
    return this.papers.removeCoeditor(actorOf(auth, request), id, userId);
  }
}

/** One print request: its teacher, co-editors, secretariat and the organization's managers. */
@ApiTags('exam-papers')
@Controller('print-requests')
@UseGuards(AuthGuard)
export class PrintRequestsController {
  constructor(
    private readonly papers: ExamPapersService,
    private readonly secretariat: SecretariatService,
  ) {}

  @Get(':id')
  page(@Auth() auth: AuthContext, @Param('id') id: string): Promise<PrintRequestPage> {
    return this.secretariat.page(auth.user.id, id);
  }

  /** Changes before opening (teacher). */
  @Patch(':id')
  @ApiZodBody(updatePrintSchema)
  update(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(updatePrintSchema) body: z.infer<typeof updatePrintSchema>,
    @Req() request: Request,
  ): Promise<ExamPaperDetail> {
    return this.papers.update(actorOf(auth, request), id, body);
  }

  @Post(':id/cancel')
  @HttpCode(204)
  async cancel(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Req() request: Request,
  ): Promise<void> {
    await this.papers.cancel(actorOf(auth, request), id);
  }

  /** Opens the subject: a watermarked preview link (never before the availability date). */
  @Post(':id/preview')
  @HttpCode(200)
  preview(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Req() request: Request,
  ): Promise<PrintLink> {
    return this.secretariat.preview(actorOf(auth, request), id);
  }

  /** One-time link to the clean print file, valid 10 minutes (secretariat). */
  @Post(':id/print-link')
  @HttpCode(200)
  printLink(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Req() request: Request,
  ): Promise<PrintLink> {
    return this.secretariat.printLink(actorOf(auth, request), id);
  }

  @Post(':id/printed')
  @HttpCode(200)
  @ApiZodBody(confirmPrintedSchema)
  printed(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(confirmPrintedSchema) body: z.infer<typeof confirmPrintedSchema>,
    @Req() request: Request,
  ): Promise<PrintRequestPage> {
    return this.secretariat.confirmPrinted(actorOf(auth, request), id, body.count);
  }

  @Post(':id/handed-over')
  @HttpCode(200)
  @ApiZodBody(handOverSchema)
  handedOver(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(handOverSchema) body: z.infer<typeof handOverSchema>,
    @Req() request: Request,
  ): Promise<PrintRequestPage> {
    return this.secretariat.handOver(actorOf(auth, request), id, body.to);
  }
}

/** Secretariat screens, the managers' view of print requests, and official templates. */
@ApiTags('exam-papers')
@Controller('organizations/:orgId')
@UseGuards(AuthGuard)
export class OrgPrintController {
  constructor(
    private readonly secretariat: SecretariatService,
    private readonly templates: OrgTemplatesService,
    private readonly projects: ProjectsService,
    private readonly config: ApiConfig,
  ) {}

  @Get('print-queue')
  queue(@Auth() auth: AuthContext, @Param('orgId') orgId: string): Promise<SecretariatQueue> {
    return this.secretariat.queue(auth.user.id, orgId);
  }

  @Get('print-history')
  history(
    @Auth() auth: AuthContext,
    @Param('orgId') orgId: string,
  ): Promise<{ requests: PrintRequestView[] }> {
    return this.secretariat.history(auth.user.id, orgId);
  }

  /** Access journal: the secretariat's requests, or the whole organization for its managers. */
  @Get('print-journal')
  journal(
    @Auth() auth: AuthContext,
    @Param('orgId') orgId: string,
  ): Promise<{ events: PrintEventView[] }> {
    return this.secretariat.journal(auth.user.id, orgId);
  }

  @Get('print-requests')
  overview(@Auth() auth: AuthContext, @Param('orgId') orgId: string): Promise<OrgPrintOverview> {
    return this.secretariat.overview(auth.user.id, orgId);
  }

  @Get('templates')
  listTemplates(
    @Auth() auth: AuthContext,
    @Param('orgId') orgId: string,
  ): Promise<OrgTemplateView[]> {
    return this.templates.list(auth.user.id, orgId);
  }

  /** Adds an official template from a ZIP sent as the raw body (`application/zip`). */
  @Post('templates')
  @ApiConsumes('application/zip')
  async addTemplate(
    @Auth() auth: AuthContext,
    @Param('orgId') orgId: string,
    @ZodQuery(orgTemplateQuerySchema) query: z.infer<typeof orgTemplateQuerySchema>,
    @Req() request: Request,
  ): Promise<OrgTemplateView[]> {
    await this.projects.limitImports(auth.user.id);
    return this.projects.withImportSlot(async () => {
      const archive = await readRawBody(
        request,
        'application/zip',
        this.config.env.ZIP_MAX_ARCHIVE_BYTES,
        'archive_too_large',
      );
      return this.templates.add(actorOf(auth, request), orgId, query, archive);
    });
  }

  @Patch('templates/:templateId')
  @ApiZodBody(updateOrgTemplateSchema)
  updateTemplate(
    @Auth() auth: AuthContext,
    @Param('orgId') orgId: string,
    @Param('templateId') templateId: string,
    @ZodBody(updateOrgTemplateSchema) body: z.infer<typeof updateOrgTemplateSchema>,
    @Req() request: Request,
  ): Promise<OrgTemplateView[]> {
    return this.templates.update(actorOf(auth, request), orgId, templateId, body);
  }

  @Delete('templates/:templateId')
  removeTemplate(
    @Auth() auth: AuthContext,
    @Param('orgId') orgId: string,
    @Param('templateId') templateId: string,
    @Req() request: Request,
  ): Promise<OrgTemplateView[]> {
    return this.templates.remove(actorOf(auth, request), orgId, templateId);
  }
}
