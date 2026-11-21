import type { Template } from '@integris/db';
import {
  MAX_PROJECT_FILE_BYTES,
  ORG_TEMPLATE_CATEGORY,
  orgTemplateKey,
  type OrgTemplateView,
  TEMPLATES_BUCKET,
} from '@integris/shared';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiConfig } from '../config/api-config.js';
import { OrgContextService } from '../organizations/org-context.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { fail } from '../projects/projects.service.js';
import { readProjectZip, ZipError } from '../projects/zip-import.js';
import { StorageService } from '../storage/storage.service.js';
import type { ExamActor } from './exam-access.js';

type Actor = ExamActor & { userId: string };

/**
 * Official templates of a BUSINESS (docs/spec.md, "Modèles"): the owner and the admins add a ZIP
 * (same checks as a project import), publish, unpublish, rename or delete it. Published, it is
 * offered to the organization's active members only (TemplatesService). Each change is audited.
 */
@Injectable()
export class OrgTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orgs: OrgContextService,
    private readonly storage: StorageService,
    private readonly config: ApiConfig,
  ) {}

  private async manager(userId: string, organizationId: string) {
    const context = await this.orgs.manager(userId, organizationId);
    this.orgs.requireBusiness(context);
    return context;
  }

  private view(template: Template): OrgTemplateView {
    return {
      id: template.id,
      name: template.name,
      description: template.description,
      published: template.isPublished,
      createdAt: template.createdAt.toISOString(),
    };
  }

  async list(userId: string, organizationId: string): Promise<OrgTemplateView[]> {
    await this.manager(userId, organizationId);
    const templates = await this.prisma.client.template.findMany({
      where: { scope: 'ORGANIZATION', organizationId },
      orderBy: { createdAt: 'desc' },
    });
    return templates.map((template) => this.view(template));
  }

  /** Adds a template from a ZIP, unpublished until the owner or an admin publishes it. */
  async add(
    actor: Actor,
    organizationId: string,
    input: { name: string; description?: string },
    archive: Uint8Array,
  ): Promise<OrgTemplateView[]> {
    const context = await this.manager(actor.userId, organizationId);
    this.orgs.requireLive(context);
    const { env } = this.config;
    try {
      const { files } = await readProjectZip(archive, {
        maxFiles: env.ZIP_MAX_FILES,
        maxTotalBytes: env.ZIP_MAX_TOTAL_BYTES,
        maxFileBytes: MAX_PROJECT_FILE_BYTES,
        maxRatio: env.ZIP_MAX_RATIO,
        ratioMinBytes: env.ZIP_RATIO_MIN_BYTES,
        storageLeftBytes: Number.MAX_SAFE_INTEGER,
      });
      if (!files.length) fail(HttpStatus.UNPROCESSABLE_ENTITY, 'template_empty');
    } catch (error) {
      if (error instanceof ZipError) fail(HttpStatus.UNPROCESSABLE_ENTITY, error.code);
      throw error;
    }
    const db = this.prisma.client;
    const id = crypto.randomUUID();
    const storageKey = orgTemplateKey(organizationId, id);
    await this.storage.put(TEMPLATES_BUCKET, storageKey, archive);
    try {
      await db.$transaction(async (tx) => {
        await tx.template.create({
          data: {
            id,
            scope: 'ORGANIZATION',
            organizationId,
            name: input.name,
            description: input.description || null,
            category: ORG_TEMPLATE_CATEGORY,
            storageKey,
            isPublished: false,
            createdById: actor.userId,
          },
        });
        await this.orgs.audit(tx, actor, 'ORG_TEMPLATE_ADDED', 'Template', id, {
          organizationId,
          name: input.name,
          bytes: archive.length,
        });
      });
    } catch (error) {
      await this.storage.deleteKeys(TEMPLATES_BUCKET, [storageKey]).catch(() => undefined);
      throw error;
    }
    return this.list(actor.userId, organizationId);
  }

  private async template(organizationId: string, templateId: string): Promise<Template> {
    const template = await this.prisma.client.template.findFirst({
      where: { id: templateId, scope: 'ORGANIZATION', organizationId },
    });
    return template ?? fail(HttpStatus.NOT_FOUND, 'template_not_found');
  }

  async update(
    actor: Actor,
    organizationId: string,
    templateId: string,
    changes: { name?: string; description?: string | null; published?: boolean },
  ): Promise<OrgTemplateView[]> {
    await this.manager(actor.userId, organizationId);
    const template = await this.template(organizationId, templateId);
    await this.prisma.client.$transaction(async (tx) => {
      await tx.template.update({
        where: { id: template.id },
        data: {
          name: changes.name,
          description: changes.description === undefined ? undefined : changes.description || null,
          isPublished: changes.published,
        },
      });
      const action =
        changes.published === undefined || changes.published === template.isPublished
          ? 'ORG_TEMPLATE_CHANGED'
          : changes.published
            ? 'ORG_TEMPLATE_PUBLISHED'
            : 'ORG_TEMPLATE_UNPUBLISHED';
      await this.orgs.audit(tx, actor, action, 'Template', template.id, {
        organizationId,
        ...(changes.name !== undefined ? { name: changes.name } : {}),
      });
    });
    return this.list(actor.userId, organizationId);
  }

  /** Deletes a template; projects created from it keep their files (they were copied). */
  async remove(actor: Actor, organizationId: string, templateId: string) {
    await this.manager(actor.userId, organizationId);
    const template = await this.template(organizationId, templateId);
    await this.prisma.client.$transaction(async (tx) => {
      await tx.project.updateMany({
        where: { templateId: template.id },
        data: { templateId: null },
      });
      await tx.template.delete({ where: { id: template.id } });
      await this.orgs.audit(tx, actor, 'ORG_TEMPLATE_DELETED', 'Template', template.id, {
        organizationId,
        name: template.name,
      });
    });
    await this.storage.deleteKeys(TEMPLATES_BUCKET, [template.storageKey]).catch(() => undefined);
    return this.list(actor.userId, organizationId);
  }
}
