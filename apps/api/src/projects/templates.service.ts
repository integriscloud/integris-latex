import type { Template } from '@integris/db';
import { TEMPLATES_BUCKET, type TemplateSummary } from '@integris/shared';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Templates a user may start from: the public templates published by Integris, and the official
 * templates of the organizations where the user is an active member.
 */
@Injectable()
export class TemplatesService {
  readonly bucket = TEMPLATES_BUCKET;

  constructor(private readonly prisma: PrismaService) {}

  private where(userId: string) {
    return {
      isPublished: true,
      OR: [
        { scope: 'PUBLIC' as const },
        {
          scope: 'ORGANIZATION' as const,
          organization: { memberships: { some: { userId, status: 'ACTIVE' as const } } },
        },
      ],
    };
  }

  async list(userId: string): Promise<TemplateSummary[]> {
    const templates = await this.prisma.client.template.findMany({
      where: this.where(userId),
      include: { organization: { select: { name: true } } },
      orderBy: [{ scope: 'desc' }, { name: 'asc' }],
    });
    return templates.map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description,
      category: template.category,
      scope: template.scope,
      organizationName: template.organization?.name ?? null,
    }));
  }

  /** A template the user may use; "not found" otherwise. */
  async visible(userId: string, templateId: string): Promise<Template> {
    const template = await this.prisma.client.template.findFirst({
      where: { id: templateId, ...this.where(userId) },
    });
    if (!template) throw new ApiError(HttpStatus.NOT_FOUND, 'not_found');
    return template;
  }
}
