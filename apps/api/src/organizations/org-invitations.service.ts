import type { Invitation, User } from '@integris/db';
import { maskContact, type OrgInvitationView } from '@integris/shared';
import { HttpStatus, Injectable } from '@nestjs/common';
import { sha256 } from '../auth/keys.js';
import { consumeLimit } from '../common/rate-limit.js';
import { ApiConfig } from '../config/api-config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isSubscriptionLive } from '../projects/quota.service.js';
import { RedisService } from '../redis/redis.service.js';
import { fail, OrgContextService } from './org-context.service.js';
import { SeatsService } from './seats.service.js';

/**
 * Invitation page of an organization (`/join#token=…`): read without a session, accepted or
 * declined with the account of the invited phone number or verified e-mail address. Accepting
 * gives the member the seat reserved by the invitation.
 */
@Injectable()
export class OrgInvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orgs: OrgContextService,
    private readonly seats: SeatsService,
    private readonly redis: RedisService,
    private readonly config: ApiConfig,
  ) {}

  private async byToken(token: string) {
    const invitation = await this.prisma.client.invitation.findUnique({
      where: { tokenHash: sha256(token) },
      include: {
        organization: { select: { name: true, type: true } },
        invitedBy: { select: { displayName: true } },
      },
    });
    return invitation ?? fail(HttpStatus.NOT_FOUND, 'invitation_invalid');
  }

  private statusOf(invitation: Invitation): OrgInvitationView['status'] {
    return invitation.status === 'PENDING' && invitation.expiresAt <= new Date()
      ? 'EXPIRED'
      : invitation.status;
  }

  async view(token: string, ip: string | null): Promise<OrgInvitationView> {
    const { env } = this.config;
    await consumeLimit(
      this.redis.client,
      `rl:invite-view:token:${sha256(token)}`,
      env.INVITATION_VIEWS_PER_HOUR_PER_TOKEN,
      3600,
    );
    await consumeLimit(
      this.redis.client,
      `rl:invite-view:ip:${sha256(ip ?? 'unknown')}`,
      env.INVITATION_VIEWS_PER_HOUR_PER_IP,
      3600,
    );
    const invitation = await this.byToken(token);
    return {
      organizationName: invitation.organization.name,
      organizationType: invitation.organization.type,
      inviterName: invitation.invitedBy.displayName,
      kind: invitation.kind,
      channel: invitation.phone ? 'phone' : 'email',
      contactHint: maskContact(invitation.phone ?? invitation.email ?? ''),
      status: this.statusOf(invitation),
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  private limitActions(userId: string): Promise<void> {
    return consumeLimit(
      this.redis.client,
      `rl:invite-action:${userId}`,
      this.config.env.INVITATION_ACTIONS_PER_HOUR,
      3600,
    );
  }

  /** The account of the invited phone number or e-mail address, verified. */
  private isInvited(user: User, invitation: Invitation): boolean {
    return invitation.phone
      ? user.phone === invitation.phone && user.phoneVerifiedAt !== null
      : user.email === invitation.email && user.emailVerifiedAt !== null;
  }

  async accept(user: User, token: string, ip: string | null): Promise<{ organizationId: string }> {
    await this.limitActions(user.id);
    const invitation = await this.byToken(token);
    if (this.statusOf(invitation) !== 'PENDING') fail(HttpStatus.GONE, 'invitation_invalid');
    if (!this.isInvited(user, invitation)) fail(HttpStatus.FORBIDDEN, 'invitation_other_account');
    const { organizationId } = invitation;
    const actor = { userId: user.id, ip };
    await this.orgs.locked(organizationId, () =>
      this.prisma.client.$transaction(async (tx) => {
        const now = new Date();
        const { count } = await tx.invitation.updateMany({
          where: { id: invitation.id, status: 'PENDING', expiresAt: { gt: now } },
          data: { status: 'ACCEPTED', acceptedById: user.id, decidedAt: now },
        });
        if (!count) fail(HttpStatus.GONE, 'invitation_invalid');
        const subscription = await tx.subscription.findFirstOrThrow({ where: { organizationId } });
        // No seat is given while the organization's subscription does not apply.
        if (!isSubscriptionLive(subscription, now))
          fail(HttpStatus.CONFLICT, 'subscription_inactive');
        const existing = await tx.membership.findFirst({
          where: { organizationId, userId: user.id },
        });
        await this.orgs.audit(
          tx,
          actor,
          'ORG_INVITATION_ACCEPTED',
          'Organization',
          organizationId,
          {
            invitationId: invitation.id,
            invitedById: invitation.invitedById,
          },
        );
        if (existing?.status === 'ACTIVE') {
          // Invited twice (phone and e-mail): the member keeps their seat, this one is given back.
          await this.seats.unreserve(tx, actor, [invitation.id], 'already_member');
          return;
        }
        const reserved = await tx.seat.findFirst({ where: { invitationId: invitation.id } });
        await this.seats.assign(tx, actor, subscription.id, user.id, now, reserved);
        const group = invitation.groupId
          ? await tx.orgGroup.findFirst({ where: { id: invitation.groupId, organizationId } })
          : null;
        const data = {
          role: 'MEMBER' as const,
          kind: invitation.kind,
          status: 'ACTIVE' as const,
          // Invited by the owner or an admin: no confirmation needed.
          approvedById: invitation.invitedById,
          approvedAt: now,
          groupId: group?.id ?? null,
        };
        if (existing) {
          await tx.membership.update({ where: { id: existing.id }, data });
        } else {
          await tx.membership.create({ data: { organizationId, userId: user.id, ...data } });
        }
        await this.orgs.audit(tx, actor, 'ORG_MEMBER_JOINED', 'Organization', organizationId, {
          userId: user.id,
          kind: invitation.kind,
          invitationId: invitation.id,
          ...(group ? { groupId: group.id } : {}),
        });
      }),
    );
    await this.seats.applied([user.id]);
    return { organizationId };
  }

  async decline(user: User, token: string, ip: string | null): Promise<void> {
    await this.limitActions(user.id);
    const invitation = await this.byToken(token);
    if (!this.isInvited(user, invitation)) fail(HttpStatus.FORBIDDEN, 'invitation_other_account');
    const actor = { userId: user.id, ip };
    await this.prisma.client.$transaction(async (tx) => {
      const { count } = await tx.invitation.updateMany({
        where: { id: invitation.id, status: 'PENDING', expiresAt: { gt: new Date() } },
        data: { status: 'DECLINED', decidedAt: new Date() },
      });
      if (!count) fail(HttpStatus.GONE, 'invitation_invalid');
      await this.seats.unreserve(tx, actor, [invitation.id], 'declined');
      await this.orgs.audit(
        tx,
        actor,
        'ORG_INVITATION_DECLINED',
        'Organization',
        invitation.organizationId,
        {
          invitationId: invitation.id,
        },
      );
    });
  }
}
