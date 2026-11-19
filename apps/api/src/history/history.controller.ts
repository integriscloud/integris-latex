import {
  createVersionSchema,
  type RestoreResult,
  restoreVersionSchema,
  type VersionDetail,
  type VersionList,
  type VersionSummary,
} from '@integris/shared';
import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { Auth, type AuthContext, AuthGuard } from '../auth/auth.guard.js';
import { ApiZodBody, ZodBody } from '../common/zod-body.js';
import { TEXT_HEADERS } from '../projects/projects.controller.js';
import { HistoryService } from './history.service.js';

/** Version history of a project: every role reads it, owner and editor name and restore. */
@ApiTags('history')
@Controller('projects/:id/versions')
@UseGuards(AuthGuard)
export class HistoryController {
  constructor(private readonly history: HistoryService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Param('id') id: string): Promise<VersionList> {
    return this.history.list(auth.user.id, id);
  }

  /** Named version of the project as stored now (the editor writes open files first). */
  @Post()
  @ApiZodBody(createVersionSchema)
  create(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(createVersionSchema) body: z.infer<typeof createVersionSchema>,
  ): Promise<VersionSummary> {
    return this.history.createNamed(auth.user.id, id, body.label);
  }

  @Get(':versionId')
  detail(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ): Promise<VersionDetail> {
    return this.history.detail(auth.user.id, id, versionId);
  }

  /** Text of one file of the version, for the preview. */
  @Get(':versionId/file')
  async file(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Query('path') path: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const bytes = await this.history.fileText(auth.user.id, id, versionId, String(path ?? ''));
    response.set(TEXT_HEADERS);
    return new StreamableFile(bytes, { type: 'text/plain; charset=utf-8' });
  }

  /** Restores the whole project, or one file with `{ path }`. */
  @Post(':versionId/restore')
  @ApiZodBody(restoreVersionSchema)
  restore(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @ZodBody(restoreVersionSchema) body: z.infer<typeof restoreVersionSchema>,
    @Req() request: Request,
  ): Promise<RestoreResult> {
    return this.history.restore(auth.user.id, id, versionId, body.path, request.ip ?? null);
  }
}
