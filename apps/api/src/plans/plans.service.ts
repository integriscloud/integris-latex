import { PLAN_CODES, type PublicPlan, publicPlansSchema } from '@integris/shared';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class PlansService {
  constructor(private readonly prisma: PrismaService) {}

  /** Active plans with their public prices and quotas, cheapest first. */
  async listPublic(): Promise<PublicPlan[]> {
    const plans = await this.prisma.client.plan.findMany({ where: { isActive: true } });
    const ordered = plans.sort((a, b) => PLAN_CODES.indexOf(a.code) - PLAN_CODES.indexOf(b.code));
    // Zod drops every column that is not part of the public schema.
    return publicPlansSchema.parse(
      ordered.map((plan) => ({ ...plan, storageBytes: Number(plan.storageBytes) })),
    );
  }
}
