import type { Project, ShareLink } from '@integris/db';
import {
  createShareLinkSchema,
  type PublicProject,
  SHARE_TOKEN,
  type ShareLinkInfo,
} from '@integris/shared';
import { HttpStatus, Injectable } from '@nestjs/common';
import { createHmac, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { sha256 } from '../auth/keys.js';
import { consumeLimit } from '../common/rate-limit.js';
import { CompileService } from '../compile/compile.service.js';
import { ApiConfig } from '../config/api-config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FilesService } from '../projects/files.service.js';
import { fail, ProjectsService } from '../projects/projects.service.js';
import { RedisService } from '../redis/redis.service.js';
import { type Actor, ProjectAuditService } from '../projects/project-audit.service.js';

const HOUR_MS = 3_600_000;

/**
 * Public read-only links (docs/spec.md, "Lien public"): off by default, created by the owner, no
 * account needed. They show the last successful PDF, and the sources when the owner included
 * them; never comments, history or compilation. One active link per project, optional expiry,
 * revoked at once. Each creation, opening and revocation is written to the audit log.
 *
 * The token is an HMAC of the link id with a key derived from AUTH_SECRET (32 bytes): the owner
 * sees the link again, the database only holds its SHA-256.
 */
@Injectable()
export class ShareLinksService {
  private readonly key: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly files: FilesService,
    private readonly compile: CompileService,
    private readonly audit: ProjectAuditService,
    private readonly redis: RedisService,
    private readonly config: ApiConfig,
  ) {
    this.key = createHmac('sha256', config.env.AUTH_SECRET)
      .update('integris:share-link:v1')
      .digest();
  }

  private tokenOf(linkId: string): string {
    return createHmac('sha256', this.key).update(linkId).digest('base64url');
  }

  private info(link: ShareLink, locale: string): ShareLinkInfo {
    const base = this.config.env.PUBLIC_WEB_URL.replace(/\/+$/, '');
    return {
      id: link.id,
      url: `${base}/${locale}/p/${this.tokenOf(link.id)}`,
      includeSources: link.includeSources,
      expiresAt: link.expiresAt?.toISOString() ?? null,
      createdAt: link.createdAt.toISOString(),
    };
  }

  private activeRow(projectId: string): Promise<ShareLink | null> {
    return this.prisma.client.shareLink.findFirst({
      where: {
        projectId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** The active link of a project (the caller checked the share right). */
  async active(projectId: string, locale: string): Promise<ShareLinkInfo | null> {
    const link = await this.activeRow(projectId);
    return link ? this.info(link, locale) : null;
  }

  async create(
    actor: Actor & { userId: string; locale: string },
    projectId: string,
    body: z.output<typeof createShareLinkSchema>,
  ): Promise<ShareLinkInfo> {
    const { project } = await this.projects.require(actor.userId, projectId, 'share');
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    if (expiresAt && expiresAt <= new Date()) fail(HttpStatus.BAD_REQUEST, 'invalid_request');
    const link = await this.projects.runLocked(project.ownerId, async () => {
      if (await this.activeRow(projectId)) fail(HttpStatus.CONFLICT, 'link_exists');
      const id = randomUUID();
      return this.prisma.client.$transaction(async (tx) => {
        const row = await tx.shareLink.create({
          data: {
            id,
            projectId,
            tokenHash: sha256(this.tokenOf(id)),
            includeSources: body.includeSources,
            createdById: actor.userId,
            expiresAt,
          },
        });
        await this.audit.write(tx, actor, 'PUBLIC_LINK_CREATED', projectId, {
          linkId: row.id,
          includeSources: row.includeSources,
          expiresAt: row.expiresAt?.toISOString() ?? null,
        });
        return row;
      });
    });
    return this.info(link, actor.locale);
  }

  async revoke(actor: Actor & { userId: string }, projectId: string, linkId: string) {
    await this.projects.require(actor.userId, projectId, 'share');
    await this.prisma.client.$transaction(async (tx) => {
      const { count } = await tx.shareLink.updateMany({
        where: { id: linkId, projectId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (!count) fail(HttpStatus.NOT_FOUND, 'not_found');
      await this.audit.write(tx, actor, 'PUBLIC_LINK_REVOKED', projectId, { linkId });
    });
  }

  // ───────────── Visitors ─────────────

  /** The link of a token and its project, refused once revoked, expired or in the trash. */
  private async resolve(
    token: string,
    ip: string | null,
  ): Promise<{ link: ShareLink; project: Project }> {
    // Per token first; per address only as a high backstop (many mobile users share one).
    const { env } = this.config;
    await consumeLimit(
      this.redis.client,
      `rl:public:token:${sha256(token)}`,
      env.PUBLIC_LINK_READS_PER_HOUR_PER_TOKEN,
      3600,
    );
    await consumeLimit(
      this.redis.client,
      `rl:public:ip:${sha256(ip ?? 'unknown')}`,
      env.PUBLIC_LINK_READS_PER_HOUR_PER_IP,
      3600,
    );
    if (!SHARE_TOKEN.test(token)) fail(HttpStatus.NOT_FOUND, 'link_invalid');
    const link = await this.prisma.client.shareLink.findUnique({
      where: { tokenHash: sha256(token) },
      include: { project: true },
    });
    if (
      !link ||
      link.revokedAt ||
      (link.expiresAt && link.expiresAt <= new Date()) ||
      link.project.deletedAt
    ) {
      return fail(HttpStatus.NOT_FOUND, 'link_invalid');
    }
    return { link, project: link.project };
  }

  /**
   * Counts an opening: one row per link, address and hour with a counter. The first opening of
   * the hour also writes the audit entry, in the same transaction.
   */
  private async countOpening(link: ShareLink, ip: string | null): Promise<void> {
    const hour = new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS);
    const where = { linkId: link.id, ip: ip ?? '', hour };
    await this.prisma.client.$transaction(async (tx) => {
      const { count } = await tx.shareLinkOpening.createMany({
        data: [where],
        skipDuplicates: true,
      });
      if (count) {
        await this.audit.write(tx, { userId: null, ip }, 'PUBLIC_LINK_OPENED', link.projectId, {
          linkId: link.id,
          hour: hour.toISOString(),
        });
      } else {
        await tx.shareLinkOpening.update({
          where: { linkId_ip_hour: where },
          data: { count: { increment: 1 }, lastAt: new Date() },
        });
      }
    });
  }

  /** What a visitor sees; openings are counted and audited (see countOpening). */
  async open(token: string, ip: string | null): Promise<PublicProject> {
    const { link, project } = await this.resolve(token, ip);
    await this.countOpening(link, ip);
    const [pdf, files] = await Promise.all([
      this.compile.publicPdf(project.id, project.name),
      link.includeSources
        ? this.prisma.client.projectFile.findMany({
            where: { projectId: project.id },
            orderBy: { path: 'asc' },
          })
        : null,
    ]);
    return {
      name: project.name,
      pdf,
      files:
        files?.map((file) => ({
          id: file.id,
          path: file.path,
          kind: file.kind,
          sizeBytes: file.sizeBytes,
        })) ?? null,
    };
  }

  /** A text file of a link that includes the sources (read only). */
  async readText(token: string, fileId: string, ip: string | null): Promise<Uint8Array> {
    const { link, project } = await this.resolve(token, ip);
    if (!link.includeSources) fail(HttpStatus.NOT_FOUND, 'not_found');
    return this.files.storedText(project.id, fileId);
  }
}
