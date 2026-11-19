import type { Prisma } from '@integris/db';
import {
  type CommentAnchor,
  type CommentInfo,
  type CommentList,
  type CreateCommentRequest,
  type DecideSuggestionRequest,
} from '@integris/shared';
import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectEventsService } from '../projects/project-events.service.js';
import { fail, ProjectsService } from '../projects/projects.service.js';

const person = { select: { id: true, displayName: true } } as const;

const INCLUDE = {
  author: person,
  resolvedBy: person,
  suggestionDecidedBy: person,
  replies: { include: { author: person }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.CommentInclude;

type CommentRow = Prisma.CommentGetPayload<{ include: typeof INCLUDE }>;

const personOf = (user: { id: string; displayName: string } | null) =>
  user ? { id: user.id, name: user.displayName } : null;

/**
 * Comments anchored to a selection (docs/spec.md, "Commentaires"): replies, resolution, and
 * replacement proposals. Every role but the reader comments, answers and proposes; the owner and
 * editors apply or refuse a proposal; the author, the owner and editors resolve. The anchor is a
 * pair of Yjs relative positions: it follows the text as the others change it.
 */
@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly events: ProjectEventsService,
  ) {}

  async list(userId: string, projectId: string): Promise<CommentList> {
    const { rights } = await this.projects.access(userId, projectId);
    const rows = await this.prisma.client.comment.findMany({
      where: { projectId },
      include: INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
    return {
      comments: rows.map((row) =>
        this.view(row, rights.applySuggestion || (rights.comment && row.authorId === userId)),
      ),
    };
  }

  private view(row: CommentRow, canResolve: boolean): CommentInfo {
    return {
      id: row.id,
      fileId: row.fileId,
      anchor: row.anchor as CommentAnchor,
      quotedText: row.quotedText,
      body: row.body,
      author: personOf(row.author)!,
      createdAt: row.createdAt.toISOString(),
      suggestedText: row.suggestedText,
      suggestionStatus: row.suggestionStatus,
      suggestionDecidedBy: personOf(row.suggestionDecidedBy),
      status: row.status,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      resolvedBy: personOf(row.resolvedBy),
      replies: row.replies.map((reply) => ({
        id: reply.id,
        author: personOf(reply.author)!,
        body: reply.body,
        createdAt: reply.createdAt.toISOString(),
      })),
      canResolve,
    };
  }

  private async one(projectId: string, commentId: string) {
    const row = await this.prisma.client.comment.findFirst({
      where: { id: commentId, projectId },
      include: INCLUDE,
    });
    return row ?? fail(HttpStatus.NOT_FOUND, 'not_found');
  }

  private async changed(projectId: string, userId: string, commentId: string) {
    await this.events.publish({ type: 'comments-changed', projectId });
    const { rights } = await this.projects.access(userId, projectId);
    const row = await this.one(projectId, commentId);
    return this.view(row, rights.applySuggestion || (rights.comment && row.authorId === userId));
  }

  async create(userId: string, projectId: string, body: CreateCommentRequest) {
    await this.projects.require(userId, projectId, 'comment');
    const file = await this.prisma.client.projectFile.findFirst({
      where: { id: body.fileId, projectId },
    });
    if (!file) fail(HttpStatus.NOT_FOUND, 'file_missing');
    if (file!.kind !== 'TEXT') fail(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'not_text');
    const suggestion = body.suggestedText !== undefined;
    const comment = await this.prisma.client.comment.create({
      data: {
        projectId,
        fileId: body.fileId,
        authorId: userId,
        anchor: body.anchor,
        quotedText: body.quotedText,
        body: body.body,
        suggestedText: suggestion ? body.suggestedText : null,
        suggestionStatus: suggestion ? 'PENDING' : null,
      },
    });
    return this.changed(projectId, userId, comment.id);
  }

  async reply(userId: string, projectId: string, commentId: string, body: string) {
    await this.projects.require(userId, projectId, 'comment');
    await this.one(projectId, commentId);
    await this.prisma.client.commentReply.create({ data: { commentId, authorId: userId, body } });
    return this.changed(projectId, userId, commentId);
  }

  /** Resolves or reopens: the author, the owner and editors. */
  async resolve(userId: string, projectId: string, commentId: string, resolved: boolean) {
    const { rights } = await this.projects.require(userId, projectId, 'comment');
    const comment = await this.one(projectId, commentId);
    if (!rights.applySuggestion && comment.authorId !== userId) {
      fail(HttpStatus.FORBIDDEN, 'forbidden');
    }
    await this.prisma.client.comment.update({
      where: { id: commentId },
      data: resolved
        ? { status: 'RESOLVED', resolvedAt: new Date(), resolvedById: userId }
        : { status: 'OPEN', resolvedAt: null, resolvedById: null },
    });
    return this.changed(projectId, userId, commentId);
  }

  /**
   * Applies or refuses a proposal: the owner and editors. Applying is an edit (refused on a
   * read-only project or a locked file); the editor has changed the shared text first and sends
   * the anchor of the new text. A proposal is decided once.
   */
  async decide(
    userId: string,
    projectId: string,
    commentId: string,
    body: DecideSuggestionRequest,
  ) {
    await this.projects.require(
      userId,
      projectId,
      body.decision === 'APPLIED' ? 'edit' : 'applySuggestion',
    );
    const comment = await this.one(projectId, commentId);
    if (comment.suggestionStatus === null) fail(HttpStatus.NOT_FOUND, 'not_found');
    if (body.decision === 'APPLIED') {
      const file = comment.fileId
        ? await this.prisma.client.projectFile.findFirst({
            where: { id: comment.fileId, projectId },
          })
        : null;
      if (!file) fail(HttpStatus.NOT_FOUND, 'file_missing');
      if (file!.lockedBySubmissionId) fail(HttpStatus.FORBIDDEN, 'file_locked');
    }
    const { count } = await this.prisma.client.comment.updateMany({
      where: { id: commentId, suggestionStatus: 'PENDING' },
      data: {
        suggestionStatus: body.decision,
        suggestionDecidedById: userId,
        suggestionDecidedAt: new Date(),
        ...(body.decision === 'APPLIED' ? { anchor: body.anchor } : {}),
      },
    });
    if (!count) fail(HttpStatus.CONFLICT, 'suggestion_decided');
    return this.changed(projectId, userId, commentId);
  }
}
