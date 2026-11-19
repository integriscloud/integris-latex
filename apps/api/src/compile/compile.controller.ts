import { type Compilation, compileRequestSchema, type CompileState } from '@integris/shared';
import { Controller, Get, Param, Post, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { z } from 'zod';
import { Auth, type AuthContext, AuthGuard } from '../auth/auth.guard.js';
import { ApiZodBody, ZodBody } from '../common/zod-body.js';
import { CompileService } from './compile.service.js';

/** Answers that carry user content, read by fetch() and never shown as a page. */
const INERT = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Content-Disposition': 'attachment',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

@ApiTags('compile')
@Controller('projects/:id')
@UseGuards(AuthGuard)
export class CompileController {
  constructor(private readonly compile: CompileService) {}

  /** Last compilation, last PDF, and whether the user may compile (any role). */
  @Get('compile')
  state(@Auth() auth: AuthContext, @Param('id') id: string): Promise<CompileState> {
    return this.compile.state(auth.user.id, id);
  }

  /**
   * Queues a compilation (owner and editor). 429 `compile_limit` when the hourly quota of the
   * owner's plan is used, 403 `auto_compile_unavailable` for an automatic one on the Free plan.
   */
  @Post('compile')
  @ApiZodBody(compileRequestSchema)
  start(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(compileRequestSchema) body: z.infer<typeof compileRequestSchema>,
  ): Promise<Compilation> {
    return this.compile.start(auth.user.id, id, body.auto);
  }

  @Get('compilations/:compilationId')
  one(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('compilationId') compilationId: string,
  ): Promise<Compilation> {
    return this.compile.one(auth.user.id, id, compilationId);
  }

  /** Raw TeX log (docs/spec.md: "journal brut accessible"). */
  @Get('compilations/:compilationId/log')
  async log(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('compilationId') compilationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const object = await this.compile.output(auth.user.id, id, compilationId, 'log');
    response.set(INERT);
    return new StreamableFile(object.body, {
      type: 'text/plain; charset=utf-8',
      length: object.size,
    });
  }

  /** SyncTeX index (JSON, stored compressed). */
  @Get('compilations/:compilationId/synctex')
  async synctex(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('compilationId') compilationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const object = await this.compile.output(auth.user.id, id, compilationId, 'synctex');
    response.set({ ...INERT, 'Content-Encoding': 'gzip' });
    return new StreamableFile(object.body, { type: 'application/json', length: object.size });
  }
}
