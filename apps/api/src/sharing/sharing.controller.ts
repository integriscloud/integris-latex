import {
  changeRoleSchema,
  type CommentInfo,
  type CommentList,
  createCommentSchema,
  createShareLinkSchema,
  decideSuggestionSchema,
  type InvitationView,
  inviteSchema,
  type ProjectSharing,
  type PublicProject,
  replySchema,
  resolveCommentSchema,
  SHARE_TOKEN,
  type ShareLinkInfo,
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
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Auth, type AuthContext, AuthGuard } from '../auth/auth.guard.js';
import { ApiZodBody, ZodBody } from '../common/zod-body.js';
import { TEXT_HEADERS } from '../projects/projects.controller.js';
import { CommentsService } from './comments.service.js';
import { ShareLinksService } from './share-links.service.js';
import { SharingService } from './sharing.service.js';

const ipOf = (request: Request) => request.ip ?? null;

/** Search engines never index anything reached through a token. */
const NO_INDEX = { 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' };

const tokenSchema = z.object({ token: z.string().regex(SHARE_TOKEN) });

/** Sharing of a project: members, invitations and the public link. */
@ApiTags('sharing')
@Controller('projects/:id')
@UseGuards(AuthGuard)
export class SharingController {
  constructor(
    private readonly sharing: SharingService,
    private readonly links: ShareLinksService,
  ) {}

  private actor(auth: AuthContext, request: Request) {
    return { userId: auth.user.id, ip: ipOf(request), locale: auth.user.locale };
  }

  @Get('sharing')
  read(@Auth() auth: AuthContext, @Param('id') id: string): Promise<ProjectSharing> {
    return this.sharing.sharing(auth.user.id, id, auth.user.locale);
  }

  /** Invites by phone or e-mail (owner). 402 `collaborator_limit` above the plan limit. */
  @Post('invitations')
  @ApiZodBody(inviteSchema)
  invite(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(inviteSchema) body: z.output<typeof inviteSchema>,
    @Req() request: Request,
  ): Promise<ProjectSharing> {
    return this.sharing.invite(auth.user, id, body, ipOf(request));
  }

  @Delete('invitations/:invitationId')
  @HttpCode(204)
  async revokeInvitation(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('invitationId') invitationId: string,
    @Req() request: Request,
  ): Promise<void> {
    await this.sharing.revokeInvitation(this.actor(auth, request), id, invitationId);
  }

  @Patch('members/:userId')
  @ApiZodBody(changeRoleSchema)
  changeRole(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @ZodBody(changeRoleSchema) body: z.output<typeof changeRoleSchema>,
    @Req() request: Request,
  ): Promise<ProjectSharing> {
    return this.sharing.changeRole(this.actor(auth, request), id, userId, body.role);
  }

  @Delete('members/:userId')
  removeMember(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Req() request: Request,
  ): Promise<ProjectSharing> {
    return this.sharing.removeMember(this.actor(auth, request), id, userId);
  }

  /** Creates the public link (owner): PDF only, or PDF and sources. One active link at most. */
  @Post('links')
  @ApiZodBody(createShareLinkSchema)
  createLink(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(createShareLinkSchema) body: z.output<typeof createShareLinkSchema>,
    @Req() request: Request,
  ): Promise<ShareLinkInfo> {
    return this.links.create(this.actor(auth, request), id, body);
  }

  @Delete('links/:linkId')
  @HttpCode(204)
  async revokeLink(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('linkId') linkId: string,
    @Req() request: Request,
  ): Promise<void> {
    await this.links.revoke(this.actor(auth, request), id, linkId);
  }
}

/** Comments of a project, anchored to selections, with replies and replacement proposals. */
@ApiTags('comments')
@Controller('projects/:id/comments')
@UseGuards(AuthGuard)
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Param('id') id: string): Promise<CommentList> {
    return this.comments.list(auth.user.id, id);
  }

  @Post()
  @ApiZodBody(createCommentSchema)
  create(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @ZodBody(createCommentSchema) body: z.output<typeof createCommentSchema>,
  ): Promise<CommentInfo> {
    return this.comments.create(auth.user.id, id, body);
  }

  @Post(':commentId/replies')
  @ApiZodBody(replySchema)
  reply(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @ZodBody(replySchema) body: z.output<typeof replySchema>,
  ): Promise<CommentInfo> {
    return this.comments.reply(auth.user.id, id, commentId, body.body);
  }

  @Post(':commentId/resolve')
  @HttpCode(200)
  @ApiZodBody(resolveCommentSchema)
  resolve(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @ZodBody(resolveCommentSchema) body: z.output<typeof resolveCommentSchema>,
  ): Promise<CommentInfo> {
    return this.comments.resolve(auth.user.id, id, commentId, body.resolved);
  }

  /** Applies (after the editor changed the text) or refuses a proposal: owner and editors. */
  @Post(':commentId/suggestion')
  @HttpCode(200)
  @ApiZodBody(decideSuggestionSchema)
  decide(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @ZodBody(decideSuggestionSchema) body: z.output<typeof decideSuggestionSchema>,
  ): Promise<CommentInfo> {
    return this.comments.decide(auth.user.id, id, commentId, body);
  }
}

/**
 * Invitation page. The token travels in request bodies (from the `#token=` of the link), never in
 * an address: it stays out of server logs.
 */
@ApiTags('sharing')
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly sharing: SharingService) {}

  /** Read without a session (POST: the token stays in the body). */
  @Post('view')
  @HttpCode(200)
  @ApiZodBody(tokenSchema)
  view(
    @ZodBody(tokenSchema) body: z.output<typeof tokenSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<InvitationView> {
    response.set(NO_INDEX);
    return this.sharing.view(body.token, ipOf(request));
  }

  @Post('accept')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @ApiZodBody(tokenSchema)
  accept(
    @Auth() auth: AuthContext,
    @ZodBody(tokenSchema) body: z.output<typeof tokenSchema>,
    @Req() request: Request,
  ): Promise<{ projectId: string }> {
    return this.sharing.accept(auth.user, body.token, ipOf(request));
  }

  @Post('decline')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  @ApiZodBody(tokenSchema)
  async decline(
    @Auth() auth: AuthContext,
    @ZodBody(tokenSchema) body: z.output<typeof tokenSchema>,
    @Req() request: Request,
  ): Promise<void> {
    await this.sharing.decline(auth.user, body.token, ipOf(request));
  }
}

/** Public read-only links: no session, no cookie read, never indexed. */
@ApiTags('public')
@Controller('public')
export class PublicController {
  constructor(private readonly links: ShareLinksService) {}

  @Get(':token')
  open(
    @Param('token') token: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PublicProject> {
    response.set(NO_INDEX);
    return this.links.open(token, ipOf(request));
  }

  @Get(':token/files/:fileId')
  async file(
    @Param('token') token: string,
    @Param('fileId') fileId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const bytes = await this.links.readText(token, fileId, ipOf(request));
    response.set({ ...TEXT_HEADERS, ...NO_INDEX });
    return new StreamableFile(bytes, { type: 'text/plain; charset=utf-8' });
  }
}
