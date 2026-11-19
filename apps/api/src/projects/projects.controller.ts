import {
  ALLOWED_PROJECT_EXTENSIONS,
  createFileSchema,
  createProjectSchema,
  deleteFolderSchema,
  duplicateProjectSchema,
  type FileSaved,
  type ImportResult,
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
  Headers,
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
import { ApiError } from '../common/api-error.js';
import type { z } from 'zod';
import { ApiConfig } from '../config/api-config.js';
import { readRawBody } from '../common/raw-body.js';
import { ApiZodBody, ZodBody, ZodQuery } from '../common/zod-body.js';
import { Auth, type AuthContext, AuthGuard } from '../auth/auth.guard.js';
import { FilesService } from './files.service.js';
import { ProjectsService } from './projects.service.js';
import { TemplatesService } from './templates.service.js';

@ApiTags('projects')
@Controller('projects')
@UseGuards(AuthGuard)
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly files: FilesService,
    private readonly config: ApiConfig,
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
  trash(@Auth() auth: AuthContext, @Param('id') id: string): Promise<void> {
    return this.projects.moveToTrash(auth.user.id, id);
  }

  @Post(':id/restore')
  @HttpCode(204)
  restore(@Auth() auth: AuthContext, @Param('id') id: string): Promise<void> {
    return this.projects.restore(auth.user.id, id);
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

  /** Content of a text file for the editor; `ETag` is the version to send back in `If-Match`. */
  @Get(':id/files/:fileId/content')
  async readContent(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const { bytes, tag, writable } = await this.files.readText(auth.user.id, id, fileId);
    response.set({
      ETag: tag,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      // API data read by fetch(), never a page: inert and not readable by other sites if opened.
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': 'attachment',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-File-Writable': String(writable),
    });
    return new StreamableFile(bytes, { type: 'text/plain; charset=utf-8' });
  }

  /**
   * Saves a text file from the editor: UTF-8 sent as the raw body (`application/octet-stream`),
   * 10 MB at most, with `If-Match` set to the version loaded. 409 `edit_conflict` when it changed.
   */
  @Put(':id/files/:fileId/content')
  @ApiConsumes('application/octet-stream')
  async writeContent(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Req() request: Request,
  ): Promise<FileSaved> {
    if (!ifMatch) throw new ApiError(HttpStatus.BAD_REQUEST, 'invalid_request');
    // Rights first: a user without the edit right never gets the body read.
    await this.projects.require(auth.user.id, id, 'edit');
    return this.projects.withUploadSlot(auth.user.id, async () => {
      const bytes = await readRawBody(
        request,
        'application/octet-stream',
        MAX_PROJECT_FILE_BYTES,
        'file_too_large',
      );
      return this.files.writeText(auth.user.id, id, fileId, bytes, ifMatch);
    });
  }

  @Patch(':id/files/:fileId')
  @ApiZodBody(moveFileSchema)
  moveFile(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @ZodBody(moveFileSchema) body: z.infer<typeof moveFileSchema>,
  ): Promise<ProjectDetail> {
    return this.files.move(auth.user.id, id, fileId, body.path);
  }

  @Delete(':id/files/:fileId')
  deleteFile(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
  ): Promise<ProjectDetail> {
    return this.files.remove(auth.user.id, id, fileId);
  }

  @Patch(':id/folders')
  @ApiZodBody(moveFolderSchema)
  moveFolder(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(moveFolderSchema) body: z.infer<typeof moveFolderSchema>,
  ): Promise<ProjectDetail> {
    return this.files.moveFolder(auth.user.id, id, body.from, body.to);
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
