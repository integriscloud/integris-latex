import {
  ALLOWED_PROJECT_EXTENSIONS,
  type ArchiveGrant,
  archiveQuerySchema,
  createFileSchema,
  createFolderSchema,
  createProjectSchema,
  deleteFolderSchema,
  duplicateProjectSchema,
  type ImportResult,
  makeWritableSchema,
  MAX_PROJECT_FILE_BYTES,
  moveFileSchema,
  moveFolderSchema,
  type ProjectDetail,
  type ProjectLimits,
  type ProjectList,
  projectNameQuerySchema,
  type ProjectSummary,
  type TemplateSummary,
  updateProjectSchema,
  uploadQuerySchema,
} from '@integris/shared';
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { ApiConfig } from '../config/api-config.js';
import { readRawBody } from '../common/raw-body.js';
import { ipOf } from '../common/request-ip.js';
import { ApiZodBody, ZodBody, ZodQuery } from '../common/zod-body.js';
import { Auth, type AuthContext, AuthGuard } from '../auth/auth.guard.js';
import { FilesService } from './files.service.js';
import { PlanLimitsService } from './plan-limits.service.js';
import { fail, ProjectsService } from './projects.service.js';
import { UsageAlertsService } from './usage-alerts.service.js';
import { TemplatesService } from './templates.service.js';
import { ProjectArchiveService } from './zip-export.js';

/** Headers of user text read by fetch(), never a page: inert and unreadable by other sites. */
export const TEXT_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Content-Disposition': 'attachment',
  'Cross-Origin-Resource-Policy': 'same-origin',
} as const;

@ApiTags('projects')
@Controller('projects')
@UseGuards(AuthGuard)
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly files: FilesService,
    private readonly archives: ProjectArchiveService,
    private readonly config: ApiConfig,
    private readonly planLimits: PlanLimitsService,
    private readonly alerts: UsageAlertsService,
  ) {}

  /** Projects of the user (owned and shared), or their trash with `?view=trash`. */
  @Get()
  list(@Auth() auth: AuthContext, @Query('view') view?: string): Promise<ProjectList> {
    return this.projects.list(auth.user.id, view === 'trash' ? 'trash' : 'active');
  }

  /** New project, empty or from a template. 402 when the project limit of the plan is reached. */
  @Post()
  @ApiZodBody(createProjectSchema)
  create(
    @Auth() auth: AuthContext,
    @ZodBody(createProjectSchema) body: z.infer<typeof createProjectSchema>,
  ): Promise<ProjectSummary> {
    return body.templateId
      ? this.projects.createFromTemplate(auth.user, body.name, body.templateId)
      : this.projects.createBlank(auth.user, body.name, auth.user.locale);
  }

  /** Imports a ZIP archive sent as the raw body (`application/zip`). */
  @Post('import')
  @ApiConsumes('application/zip')
  async importZip(
    @Auth() auth: AuthContext,
    @ZodQuery(projectNameQuerySchema) query: z.infer<typeof projectNameQuerySchema>,
    @Req() request: Request,
  ): Promise<ImportResult> {
    // Rate limit first: a refused import never gets its archive read.
    await this.projects.limitImports(auth.user.id);
    // The slot is taken before reading: archives waiting for a slot are not held in memory.
    return this.projects.withImportSlot(async () => {
      const archive = await readRawBody(
        request,
        'application/zip',
        this.config.env.ZIP_MAX_ARCHIVE_BYTES,
        'archive_too_large',
      );
      return this.projects.importZip(auth.user, query.name, archive);
    });
  }

  /** Upload limits shown and checked by the app before sending a file. */
  @Get('limits')
  limits(): ProjectLimits {
    return {
      maxFileBytes: MAX_PROJECT_FILE_BYTES,
      maxArchiveBytes: this.config.env.ZIP_MAX_ARCHIVE_BYTES,
      extensions: [...ALLOWED_PROJECT_EXTENSIONS],
    };
  }

  @Get(':id')
  detail(@Auth() auth: AuthContext, @Param('id') id: string): Promise<ProjectDetail> {
    return this.projects.detail(auth.user.id, id);
  }

  /** Renames the project (owner) or changes its main file or engine (owner, editor). */
  @Patch(':id')
  @ApiZodBody(updateProjectSchema)
  update(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(updateProjectSchema) body: z.infer<typeof updateProjectSchema>,
  ): Promise<ProjectDetail> {
    return this.projects.update(auth.user.id, id, body);
  }

  /**
   * Grants a download of the whole project (owner, editors): counted against
   * ZIP_EXPORTS_PER_HOUR, with a warning when the project is too large to be imported again.
   */
  @Post(':id/archive')
  @HttpCode(200)
  grantArchive(@Auth() auth: AuthContext, @Param('id') id: string): Promise<ArchiveGrant> {
    return this.archives.grant(auth.user.id, id);
  }

  /** The project as a ZIP archive, streamed, for a token given by `POST :id/archive`. */
  @Get(':id/archive')
  async archive(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodQuery(archiveQuerySchema) query: z.infer<typeof archiveQuerySchema>,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    await this.archives.send({ userId: auth.user.id, ip: ipOf(request) }, id, query.t, response);
  }

  @Post(':id/duplicate')
  @ApiZodBody(duplicateProjectSchema)
  duplicate(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(duplicateProjectSchema) body: z.infer<typeof duplicateProjectSchema>,
  ): Promise<ProjectSummary> {
    return this.projects.duplicate(auth.user, id, body.name);
  }

  @Post(':id/trash')
  @HttpCode(204)
  async trash(@Auth() auth: AuthContext, @Param('id') id: string): Promise<void> {
    await this.projects.moveToTrash(auth.user.id, id);
    // A writable project in the trash frees a place for a read-only one (repaired by the sweep
    // when this fails: the project is in the trash either way).
    await this.planLimits.reconcileQuietly(auth.user.id);
  }

  @Post(':id/restore')
  @HttpCode(204)
  async restore(@Auth() auth: AuthContext, @Param('id') id: string): Promise<void> {
    await this.projects.restore(auth.user.id, id);
    await this.planLimits.reconcileQuietly(auth.user.id);
    this.alerts.check(auth.user.id);
  }

  /**
   * Makes a read-only project (beyond the plan's limit) writable; when every writable place is
   * taken, `release` names the project that becomes read-only instead (owner only).
   */
  @Post(':id/writable')
  @HttpCode(204)
  @ApiZodBody(makeWritableSchema)
  async makeWritable(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(makeWritableSchema) body: z.infer<typeof makeWritableSchema>,
  ): Promise<void> {
    await this.projects.access(auth.user.id, id).then(({ rights }) => {
      if (!rights.manage) fail(HttpStatus.FORBIDDEN, 'forbidden');
    });
    await this.planLimits.makeWritable(auth.user.id, id, body.release);
  }

  /** Erases a project of the trash for good (owner only, after confirmation in the app). */
  @Delete(':id')
  @HttpCode(204)
  erase(@Auth() auth: AuthContext, @Param('id') id: string): Promise<void> {
    return this.projects.eraseFromTrash(auth.user.id, id);
  }

  /** New empty text file. */
  @Post(':id/files')
  @ApiZodBody(createFileSchema)
  createFile(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(createFileSchema) body: z.infer<typeof createFileSchema>,
  ): Promise<ProjectDetail> {
    return this.files.createText(auth.user.id, id, body.path);
  }

  /** Uploads one file sent as the raw body (`application/octet-stream`), 10 MB at most. */
  @Put(':id/files/upload')
  @ApiConsumes('application/octet-stream')
  async upload(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodQuery(uploadQuerySchema) query: z.infer<typeof uploadQuerySchema>,
    @Req() request: Request,
  ): Promise<ProjectDetail> {
    // Rights first: a user without the edit right never gets the body read.
    await this.projects.require(auth.user.id, id, 'edit');
    return this.projects.withUploadSlot(auth.user.id, async () => {
      const bytes = await readRawBody(
        request,
        'application/octet-stream',
        MAX_PROJECT_FILE_BYTES,
        'file_too_large',
      );
      return this.files.upload(auth.user.id, id, query.path, bytes, query.replace === 'true');
    });
  }

  /**
   * Content of a text file as last written to storage (project search and completion). The
   * editor itself gets the live text from the collaboration server.
   */
  @Get(':id/files/:fileId/content')
  async readContent(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const bytes = await this.files.readText(auth.user.id, id, fileId);
    response.set(TEXT_HEADERS);
    return new StreamableFile(bytes, { type: 'text/plain; charset=utf-8' });
  }

  @Patch(':id/files/:fileId')
  @ApiZodBody(moveFileSchema)
  moveFile(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @ZodBody(moveFileSchema) body: z.infer<typeof moveFileSchema>,
    @Req() request: Request,
  ): Promise<ProjectDetail> {
    return this.files.move({ userId: auth.user.id, ip: ipOf(request) }, id, fileId, body.path);
  }

  @Delete(':id/files/:fileId')
  deleteFile(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
  ): Promise<ProjectDetail> {
    return this.files.remove(auth.user.id, id, fileId);
  }

  /** New empty folder, kept until it is deleted. */
  @Post(':id/folders')
  @ApiZodBody(createFolderSchema)
  createFolder(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(createFolderSchema) body: z.infer<typeof createFolderSchema>,
  ): Promise<ProjectDetail> {
    return this.files.createFolder(auth.user.id, id, body.path);
  }

  @Patch(':id/folders')
  @ApiZodBody(moveFolderSchema)
  moveFolder(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(moveFolderSchema) body: z.infer<typeof moveFolderSchema>,
    @Req() request: Request,
  ): Promise<ProjectDetail> {
    const actor = { userId: auth.user.id, ip: ipOf(request) };
    return this.files.moveFolder(actor, id, body.from, body.to);
  }

  @Delete(':id/folders')
  @ApiZodBody(deleteFolderSchema)
  deleteFolder(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(deleteFolderSchema) body: z.infer<typeof deleteFolderSchema>,
  ): Promise<ProjectDetail> {
    return this.files.removeFolder(auth.user.id, id, body.path);
  }
}

@ApiTags('projects')
@Controller('templates')
@UseGuards(AuthGuard)
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  /** Public templates and the official templates of the user's organizations. */
  @Get()
  list(@Auth() auth: AuthContext): Promise<TemplateSummary[]> {
    return this.templates.list(auth.user.id);
  }
}
