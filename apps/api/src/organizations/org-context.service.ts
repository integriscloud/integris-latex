import type { Membership, Organization, Plan, Prisma, Subscription } from '@integris/db';
import { type ApiErrorCode } from '@integris/shared';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { withEffectivePlan } from '../plans/plan-terms.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { OwnerLockService } from '../projects/owner-lock.service.js';
import { isSubscriptionLive } from '../projects/quota.service.js';

export type Tx = Prisma.TransactionClient;

export const fail = (status: HttpStatus, code: ApiErrorCode): never => {
  throw new ApiError(status, code);
};

/** The `{ code }` of an ApiError, or null for any other error. */
export function codeOf(error: unknown): ApiErrorCode | null {
  return error instanceof ApiError ? (error.getResponse() as { code: ApiErrorCode }).code : null;
}

/** Who acts, for the audit log: a signed-in user, or nobody (sweeps). */
export interface OrgActor {
  userId: string | null;
  ip: string | null;
}

/** An organization seen by one of its active members. */
export interface OrgContext {
  organization: Organization;
  subscription: Subscription & { plan: Plan };
  membership: Membership;
  isOwner: boolean;
  /** The owner, or an admin of a BUSINESS: manages members, groups and supervision. */
  manages: boolean;
}

/**
 * Access to an organization: only its active members see it, and only the owner and the admins
 * (BUSINESS) manage it. Payment never gives access to project contents: nothing here reads them.
 */
@Injectable()
export class OrgContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: OwnerLockService,
  ) {}

  async load(userId: string, organizationId: string): Promise<OrgContext> {
    const db = this.prisma.client;
    const membership = await db.membership.findFirst({
      where: { organizationId, userId, status: 'ACTIVE' },
    });
    if (!membership) return fail(HttpStatus.NOT_FOUND, 'org_not_found');
    const [organization, subscription] = await Promise.all([
      db.organization.findUniqueOrThrow({ where: { id: organizationId } }),
      db.subscription.findFirst({
        where: { organizationId },
        include: { plan: true, planRevision: true },
      }),
    ]);
    if (!subscription) return fail(HttpStatus.NOT_FOUND, 'org_not_found');
    const isOwner = membership.role === 'OWNER';
    return {
      organization,
      // Quotas of the version frozen by the paid period, a higher current quota winning.
      subscription: withEffectivePlan(subscription),
      membership,
      isOwner,
      manages: isOwner || (membership.role === 'ADMIN' && organization.type === 'BUSINESS'),
    };
  }

  async manager(userId: string, organizationId: string): Promise<OrgContext> {
    const context = await this.load(userId, organizationId);
    if (!context.manages) fail(HttpStatus.FORBIDDEN, 'org_forbidden');
    return context;
  }

  async owner(userId: string, organizationId: string): Promise<OrgContext> {
    const context = await this.load(userId, organizationId);
    if (!context.isOwner) fail(HttpStatus.FORBIDDEN, 'org_forbidden');
    return context;
  }

  requireBusiness(context: OrgContext): void {
    if (context.organization.type !== 'BUSINESS') fail(HttpStatus.CONFLICT, 'business_only');
  }

  /** New seats are given only while the organization's subscription applies. */
  requireLive(context: OrgContext, now = new Date()): void {
    if (!isSubscriptionLive(context.subscription, now)) {
      fail(HttpStatus.CONFLICT, 'subscription_inactive');
    }
  }

  /** Serializes the seat and membership changes of one organization. */
  locked<T>(organizationId: string, task: () => Promise<T>): Promise<T> {
    return this.locks.runKey(`lock:org:${organizationId}`, task);
  }

  async audit(
    tx: Tx,
    actor: OrgActor,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Prisma.InputJsonObject,
  ): Promise<void> {
    await tx.auditLog.create({
      data: { actorId: actor.userId, action, targetType, targetId, metadata, ip: actor.ip },
    });
  }
}
