import type { PromoCode, Template } from '@integris/db';
import {
  type AdminPromo,
  type AdminTemplate,
  type ApiErrorCode,
  MAX_PROJECT_FILE_BYTES,
  type PaidPlanCode,
  publicTemplateKey,
  TEMPLATES_BUCKET,
} from '@integris/shared';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { ApiConfig } from '../config/api-config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readProjectZip, ZipError } from '../projects/zip-import.js';
import { StorageService } from '../storage/storage.service.js';
import type { AdminActor } from './admin-actor.js';

const fail = (status: HttpStatus, code: ApiErrorCode): never => {
  throw new ApiError(status, code);
};

/** Promo codes and public templates of the back-office, each change audited (step 14). */
@Injectable()
export class AdminCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: ApiConfig,
  ) {}

  // ───────────── Promo codes ─────────────

  private promoView(promo: PromoCode): AdminPromo {
    return {
      id: promo.id,
      code: promo.code,
      percentOff: promo.percentOff,
      planCodes: promo.planCodes,
      validUntil: promo.validUntil?.toISOString() ?? null,
      maxRedemptions: promo.maxRedemptions,
      redemptionCount: promo.redemptionCount,
      isActive: promo.isActive,
      createdAt: promo.createdAt.toISOString(),
    };
  }

  async promos(): Promise<AdminPromo[]> {
    const rows = await this.prisma.client.promoCode.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map((row) => this.promoView(row));
  }

  async createPromo(
    actor: AdminActor,
    input: {
      code: string;
      percentOff: number;
      planCodes: PaidPlanCode[];
      validUntil: string | null;
      maxRedemptions: number | null;
    },
  ): Promise<AdminPromo[]> {
    await this.prisma.client
      .$transaction(async (tx) => {
        const promo = await tx.promoCode.create({
          data: {
            code: input.code,
            percentOff: input.percentOff,
            planCodes: [...new Set(input.planCodes)],
            validUntil: input.validUntil ? new Date(input.validUntil) : null,
            maxRedemptions: input.maxRedemptions,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: actor.userId,
            action: 'ADMIN_PROMO_CREATED',
            targetType: 'PromoCode',
            targetId: promo.id,
            metadata: { ...input, planCodes: promo.planCodes },
            ip: actor.ip,
          },
        });
      })
      .catch((error: unknown) => {
        if ((error as { code?: string }).code === 'P2002') {
          fail(HttpStatus.CONFLICT, 'promo_code_taken');
        }
        throw error;
      });
    return this.promos();
  }

  /** Percentage and plans are fixed once the code was used; the rest stays editable. */
  async updatePromo(
    actor: AdminActor,
    id: string,
    changes: {
      percentOff?: number;
      planCodes?: PaidPlanCode[];
      validUntil?: string | null;
      maxRedemptions?: number | null;
      isActive?: boolean;
    },
  ): Promise<AdminPromo[]> {
    await this.prisma.client.$transaction(async (tx) => {
      const promo = await tx.promoCode.findUnique({ where: { id } });
      if (!promo) return fail(HttpStatus.NOT_FOUND, 'promo_not_found');
      const terms =
        (changes.percentOff !== undefined && changes.percentOff !== promo.percentOff) ||
        (changes.planCodes !== undefined &&
          [...changes.planCodes].sort().join() !== [...promo.planCodes].sort().join());
      if (terms && promo.redemptionCount > 0) fail(HttpStatus.CONFLICT, 'promo_locked');
      if (
        changes.maxRedemptions !== undefined &&
        changes.maxRedemptions !== null &&
        changes.maxRedemptions < promo.redemptionCount
      ) {
        fail(HttpStatus.UNPROCESSABLE_ENTITY, 'promo_max_below_used');
      }
      await tx.promoCode.update({
        where: { id },
        data: {
          percentOff: changes.percentOff,
          planCodes: changes.planCodes ? [...new Set(changes.planCodes)] : undefined,
          validUntil:
            changes.validUntil === undefined
              ? undefined
              : changes.validUntil
                ? new Date(changes.validUntil)
                : null,
          maxRedemptions: changes.maxRedemptions,
          isActive: changes.isActive,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.userId,
          action: 'ADMIN_PROMO_UPDATED',
          targetType: 'PromoCode',
          targetId: id,
          metadata: { code: promo.code, changes },
          ip: actor.ip,
        },
      });
    });
    return this.promos();
  }

  // ───────────── Public templates ─────────────

  private async templateView(template: Template): Promise<AdminTemplate> {
    return {
      id: template.id,
      name: template.name,
      description: template.description,
      category: template.category,
      institution: template.institution,
      published: template.isPublished,
      projects: await this.prisma.client.project.count({ where: { templateId: template.id } }),
      createdAt: template.createdAt.toISOString(),
    };
  }

  async templates(): Promise<AdminTemplate[]> {
    const rows = await this.prisma.client.template.findMany({
      where: { scope: 'PUBLIC' },
      orderBy: { createdAt: 'desc' },
    });
    return Promise.all(rows.map((row) => this.templateView(row)));
  }

  /** Adds a public template from a ZIP (same checks as a project import), unpublished. */
  async addTemplate(
    actor: AdminActor,
    input: { name: string; description?: string; category: string; institution?: string },
    archive: Uint8Array,
  ): Promise<AdminTemplate[]> {
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
    const id = crypto.randomUUID();
    const storageKey = publicTemplateKey(id);
    await this.storage.put(TEMPLATES_BUCKET, storageKey, archive);
    try {
      await this.prisma.client.$transaction(async (tx) => {
        await tx.template.create({
          data: {
            id,
            scope: 'PUBLIC',
            name: input.name,
            description: input.description || null,
            category: input.category,
            institution: input.institution || null,
            storageKey,
            isPublished: false,
            createdById: actor.userId,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: actor.userId,
            action: 'ADMIN_TEMPLATE_ADDED',
            targetType: 'Template',
            targetId: id,
            metadata: { name: input.name, category: input.category, bytes: archive.length },
            ip: actor.ip,
          },
        });
      });
    } catch (error) {
      await this.storage.deleteKeys(TEMPLATES_BUCKET, [storageKey]).catch(() => undefined);
      throw error;
    }
    return this.templates();
  }

  private async publicTemplate(id: string): Promise<Template> {
    const template = await this.prisma.client.template.findFirst({
      where: { id, scope: 'PUBLIC' },
    });
    return template ?? fail(HttpStatus.NOT_FOUND, 'template_not_found');
  }

  async updateTemplate(
    actor: AdminActor,
    id: string,
    changes: {
      name?: string;
      description?: string | null;
      category?: string;
      institution?: string | null;
      published?: boolean;
    },
  ): Promise<AdminTemplate[]> {
    const template = await this.publicTemplate(id);
    await this.prisma.client.$transaction(async (tx) => {
      await tx.template.update({
        where: { id },
        data: {
          name: changes.name,
          description: changes.description === undefined ? undefined : changes.description || null,
          category: changes.category,
          institution: changes.institution === undefined ? undefined : changes.institution || null,
          isPublished: changes.published,
        },
      });
      const action =
        changes.published === undefined || changes.published === template.isPublished
          ? 'ADMIN_TEMPLATE_CHANGED'
          : changes.published
            ? 'ADMIN_TEMPLATE_PUBLISHED'
            : 'ADMIN_TEMPLATE_UNPUBLISHED';
      await tx.auditLog.create({
        data: {
          actorId: actor.userId,
          action,
          targetType: 'Template',
          targetId: id,
          metadata: { name: changes.name ?? template.name, changes },
          ip: actor.ip,
        },
      });
    });
    return this.templates();
  }

  /** Deletes a public template; projects created from it keep their files (they were copied). */
  async removeTemplate(actor: AdminActor, id: string): Promise<AdminTemplate[]> {
    const template = await this.publicTemplate(id);
    await this.prisma.client.$transaction(async (tx) => {
      await tx.project.updateMany({ where: { templateId: id }, data: { templateId: null } });
      await tx.template.delete({ where: { id } });
      await tx.auditLog.create({
        data: {
          actorId: actor.userId,
          action: 'ADMIN_TEMPLATE_DELETED',
          targetType: 'Template',
          targetId: id,
          metadata: { name: template.name },
          ip: actor.ip,
        },
      });
    });
    await this.storage.deleteKeys(TEMPLATES_BUCKET, [template.storageKey]).catch(() => undefined);
    return this.templates();
  }
}
