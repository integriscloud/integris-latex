import { type AccountUsage, accountUsageSchema, usageLevel } from '@integris/shared';
import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Auth, type AuthContext, AuthGuard } from '../auth/auth.guard.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { combineQuotas, QuotaService } from './quota.service.js';

@ApiTags('usage')
@Controller('usage')
@UseGuards(AuthGuard)
export class UsageController {
  constructor(
    private readonly quota: QuotaService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Usage of the signed-in user against the quotas of their plans ("Ma consommation"): every
   * quota of the grid, the plans it comes from (the best of each wins), the counters of the
   * month and the owned projects, writable or read-only.
   */
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Quotas, usage and alert level of each quota.' })
  async usage(@Auth() auth: AuthContext): Promise<AccountUsage> {
    const userId = auth.user.id;
    const [sources, storage, hour, month, projects, credit] = await Promise.all([
      this.quota.sources(userId),
      this.quota.storageUsed(userId),
      this.quota.compilesThisHour(userId),
      this.quota.month(userId),
      this.prisma.client.project.findMany({
        where: { ownerId: userId, deletedAt: null },
        select: { id: true, name: true, lastActivityAt: true, readOnlyReason: true },
        orderBy: [{ lastActivityAt: 'desc' }, { createdAt: 'desc' }],
      }),
      this.prisma.client.creditEntry.aggregate({
        where: { userId },
        _sum: { amountXof: true },
      }),
    ]);
    const quotas = combineQuotas(sources.map((source) => source.plan));
    const meter = (used: number, max: number | null) => ({
      used,
      max,
      level: usageLevel(used, max),
    });
    const owned = (readOnly: boolean) =>
      projects
        .filter((project) => (project.readOnlyReason !== null) === readOnly)
        .map((project) => ({
          id: project.id,
          name: project.name,
          lastActivityAt: project.lastActivityAt.toISOString(),
        }));
    return accountUsageSchema.parse({
      plan: { code: quotas.planCode, name: quotas.planName },
      sources: sources.map((source) => ({
        kind: source.kind,
        planCode: source.plan.code,
        planName: { fr: source.plan.nameFr, en: source.plan.nameEn },
        organizationName: source.organizationName,
        periodEnd: source.periodEnd?.toISOString() ?? null,
      })),
      projects: meter(projects.length, quotas.maxProjects),
      storage: meter(Number(storage), Number(quotas.storageBytes)),
      compilesPerHour: {
        ...meter(hour.used, quotas.maxCompilesPerHour),
        nextSlotSeconds: hour.nextSlotSeconds,
      },
      month: {
        periodStart: month.periodStart.toISOString(),
        compileCount: month.compileCount,
        compileSeconds: month.compileSeconds,
      },
      limits: {
        maxCollaborators: quotas.maxCollaborators,
        maxCompileSeconds: quotas.maxCompileSeconds,
        historyDays: quotas.historyDays,
        autoCompile: quotas.autoCompile,
        compilePriority: quotas.compilePriority,
        supervisionDashboard: quotas.supervisionDashboard,
        maxSupervisedStudents: quotas.maxSupervisedStudents,
      },
      creditBalance: Math.max(0, credit._sum.amountXof ?? 0),
      writable: owned(false),
      readOnly: owned(true),
    });
  }
}
