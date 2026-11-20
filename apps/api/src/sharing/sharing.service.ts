import type { ProjectInvitation, User } from '@integris/db';
import {
  countsAsCollaborator,
  INVITATION_TTL_DAYS,
  type InvitationView,
  inviteSchema,
  maskContact,
  normalizePhone,
  type ProjectSharing,
  type ShareableRole,
} from '@integris/shared';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import { sha256 } from '../auth/keys.js';
import { ApiError } from '../common/api-error.js';
import { consumeLimit } from '../common/rate-limit.js';
import { ApiConfig } from '../config/api-config.js';
import { MAIL_SENDER, type MailSender } from '../mail/mail-sender.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectEventsService } from '../projects/project-events.service.js';
import { fail, ProjectsService } from '../projects/projects.service.js';
import { QuotaService } from '../projects/quota.service.js';
import { RedisService } from '../redis/redis.service.js';
import { consumeSmsBudget } from '../sms/sms-budget.js';
import { SMS_SENDER, type SmsSender } from '../sms/sms-sender.js';
import { ProjectAuditService } from '../projects/project-audit.service.js';
import { invitationMail, invitationSms } from './sharing-messages.js';
import { ShareLinksService } from './share-links.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

type Invite = z.output<typeof inviteSchema>;

/** A signed-in user acting on a project, for the audit log. */
export interface Actor {
  userId: string;
  ip: string | null;
  /** Language of the interface: public link addresses are given in it. */
  locale: string;
}

/**
 * Sharing of a project (docs/spec.md, "Partage"): the owner invites by phone or e-mail with a
 * role; the invitee always accepts, with the account of that phone or e-mail (created by the link
 * when needed). Only the owner shares, changes a role or removes an access. Each step writes an
 * audit entry and asks the collaboration server to check the open connections again.
 */
@Injectable()
export class SharingService {
  private readonly logger = new Logger('Sharing');

  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly quota: QuotaService,
    private readonly events: ProjectEventsService,
    private readonly links: ShareLinksService,
    private readonly auditLog: ProjectAuditService,
    private readonly redis: RedisService,
    private readonly config: ApiConfig,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
  ) {}

  // ───────────── Reading ─────────────

  /** Who has access. Pending invitations and the public link are shown to the owner only. */
  async sharing(userId: string, projectId: string, locale: string): Promise<ProjectSharing> {
    const { project, rights } = await this.projects.access(userId, projectId);
    const db = this.prisma.client;
    const [owner, members, invitations, quotas] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { id: project.ownerId } }),
      db.projectMember.findMany({
        where: { projectId },
        include: { user: { select: { displayName: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      this.pending(projectId),
      this.quota.quotas(project.ownerId),
    ]);
    const used =
      members.filter((member) => countsAsCollaborator(member.role)).length +
      invitations.filter((invitation) => countsAsCollaborator(invitation.role)).length;
    return {
      owner: { userId: owner.id, name: owner.displayName },
      members: members.map((member) => ({
        userId: member.userId,
        name: member.user.displayName,
        role: member.role,
        counted: countsAsCollaborator(member.role),
      })),
      invitations: rights.share
        ? invitations.map((invitation) => ({
            id: invitation.id,
            channel: invitation.phone ? 'phone' : 'email',
            contact: invitation.phone ?? invitation.email ?? '',
            role: invitation.role as ShareableRole,
            message: invitation.message,
            createdAt: invitation.createdAt.toISOString(),
            expiresAt: invitation.expiresAt.toISOString(),
            counted: countsAsCollaborator(invitation.role),
          }))
        : [],
      link: rights.share ? await this.links.active(projectId, locale) : null,
      collaborators: { used, max: quotas.maxCollaborators },
      canShare: rights.share,
    };
  }

  /** Pending invitations still valid; the expired ones are marked as such first. */
  private async pending(projectId: string): Promise<ProjectInvitation[]> {
    const db = this.prisma.client;
    const now = new Date();
    await db.projectInvitation.updateMany({
      where: { projectId, status: 'PENDING', expiresAt: { lte: now } },
      data: { status: 'EXPIRED' },
    });
    return db.projectInvitation.findMany({
      where: { projectId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Refuses one more counted collaborator above the limit of the owner's plan (read from the
   * `Plan` table): members and pending invitations count, the owner and supervisors do not.
   */
  private async checkCollaborators(
    projectId: string,
    ownerId: string,
    except: { invitationId?: string; userId?: string } = {},
  ): Promise<void> {
    const { maxCollaborators } = await this.quota.quotas(ownerId);
    if (maxCollaborators === null) return;
    const [members, invitations] = await Promise.all([
      this.prisma.client.projectMember.findMany({ where: { projectId } }),
      this.pending(projectId),
    ]);
    const used =
      members.filter(
        (member) => member.userId !== except.userId && countsAsCollaborator(member.role),
      ).length +
      invitations.filter(
        (invitation) =>
          invitation.id !== except.invitationId && countsAsCollaborator(invitation.role),
      ).length;
    if (used + 1 > maxCollaborators) fail(HttpStatus.PAYMENT_REQUIRED, 'collaborator_limit');
  }

  // ───────────── Inviting ─────────────

  async invite(
    owner: User,
    projectId: string,
    body: Invite,
    ip: string | null,
  ): Promise<ProjectSharing> {
    const { project } = await this.projects.require(owner.id, projectId, 'share');
    const contact = this.contactOf(body);
    if (contact.phone ? contact.phone === owner.phone : contact.email === owner.email) {
      fail(HttpStatus.CONFLICT, 'cannot_invite_self');
    }
    await this.limitInvitations(owner.id);
    const token = randomBytes(32).toString('base64url');
    // Under the owner lock: two invitations sent together cannot both take the last place.
    const invitation = await this.projects.runLocked(project.ownerId, async () => {
      const db = this.prisma.client;
      const existing = await db.user.findFirst({
        where: contact.phone ? { phone: contact.phone } : { email: contact.email },
        select: { id: true },
      });
      if (existing) {
        const member = await db.projectMember.findUnique({
          where: { projectId_userId: { projectId, userId: existing.id } },
        });
        if (member || existing.id === project.ownerId) fail(HttpStatus.CONFLICT, 'already_member');
      }
      const pending = await this.pending(projectId);
      if (
        pending.some((item) =>
          contact.phone ? item.phone === contact.phone : item.email === contact.email,
        )
      ) {
        fail(HttpStatus.CONFLICT, 'already_invited');
      }
      if (countsAsCollaborator(body.role))
        await this.checkCollaborators(projectId, project.ownerId);
      // The SMS budget is taken before anything is written.
      if (contact.phone) {
        await consumeSmsBudget(this.redis.client, this.config.env.SMS_DAILY_LIMIT, this.logger);
      }
      const sent = {
        invitedById: owner.id,
        role: body.role,
        channel: contact.phone ? 'phone' : 'email',
      };
      return db.$transaction(async (tx) => {
        const row = await tx.projectInvitation.create({
          data: {
            projectId,
            invitedById: owner.id,
            phone: contact.phone ?? null,
            email: contact.email ?? null,
            role: body.role,
            message: body.message ?? null,
            locale: owner.locale,
            tokenHash: sha256(token),
            expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * DAY_MS),
          },
        });
        await this.auditLog.write(
          tx,
          { userId: owner.id, ip },
          'PROJECT_INVITATION_SENT',
          projectId,
          {
            invitationId: row.id,
            role: sent.role,
            channel: sent.channel,
          },
        );
        return row;
      });
    });

    const link = `${this.config.env.PUBLIC_WEB_URL.replace(/\/+$/, '')}/${owner.locale}/invite#token=${token}`;
    try {
      if (contact.phone) {
        await this.sms.send(contact.phone, invitationSms[owner.locale](link, INVITATION_TTL_DAYS));
      } else {
        await this.mail.send(
          invitationMail[owner.locale]({
            to: contact.email!,
            inviterName: owner.displayName,
            projectName: project.name,
            role: body.role,
            message: body.message,
            link,
            days: INVITATION_TTL_DAYS,
          }),
        );
      }
    } catch (error) {
      // Not sent: the invitation does not stay pending (it would take a place for nothing).
      await this.prisma.client.$transaction(async (tx) => {
        await tx.projectInvitation.update({
          where: { id: invitation.id },
          data: { status: 'REVOKED', decidedAt: new Date() },
        });
        await this.auditLog.write(
          tx,
          { userId: owner.id, ip },
          'PROJECT_INVITATION_REVOKED',
          projectId,
          {
            invitationId: invitation.id,
            reason: 'not_sent',
          },
        );
      });
      throw error;
    }
    return this.sharing(owner.id, projectId, owner.locale);
  }

  private contactOf(body: Invite): { phone?: string; email?: string } {
    if (body.channel === 'email') return { email: body.email };
    const phone = normalizePhone(body.phone, body.dialCode);
    if (!phone) fail(HttpStatus.BAD_REQUEST, 'invalid_contact');
    const allowed = this.config.env.AUTH_ALLOWED_DIAL_CODES;
    if (!allowed.some((code) => phone!.startsWith(`+${code}`))) {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'country_not_allowed');
    }
    return { phone: phone! };
  }

  /** SHARE_INVITATIONS_PER_DAY per owner account and UTC day, every project together. */
  private limitInvitations(userId: string): Promise<void> {
    return consumeLimit(
      this.redis.client,
      `rl:invite:${userId}:${new Date().toISOString().slice(0, 10)}`,
      this.config.env.SHARE_INVITATIONS_PER_DAY,
      2 * 86_400,
    );
  }

  async revokeInvitation(actor: Actor, projectId: string, invitationId: string): Promise<void> {
    await this.projects.require(actor.userId, projectId, 'share');
    await this.prisma.client.$transaction(async (tx) => {
      const { count } = await tx.projectInvitation.updateMany({
        where: { id: invitationId, projectId, status: 'PENDING' },
        data: { status: 'REVOKED', decidedAt: new Date() },
      });
      if (!count) fail(HttpStatus.NOT_FOUND, 'not_found');
      await this.auditLog.write(tx, actor, 'PROJECT_INVITATION_REVOKED', projectId, {
        invitationId,
      });
    });
  }

  // ───────────── Members ─────────────

  async changeRole(
    actor: Actor,
    projectId: string,
    memberId: string,
    role: ShareableRole,
  ): Promise<ProjectSharing> {
    const { project } = await this.projects.require(actor.userId, projectId, 'share');
    const previous = await this.projects.runLocked(project.ownerId, async () => {
      const db = this.prisma.client;
      const member = await db.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId: memberId } },
      });
      if (!member) return fail(HttpStatus.NOT_FOUND, 'not_found');
      if (member.role === role) return role;
      if (countsAsCollaborator(role) && !countsAsCollaborator(member.role)) {
        await this.checkCollaborators(projectId, project.ownerId, { userId: memberId });
      }
      await db.$transaction(async (tx) => {
        await tx.projectMember.update({ where: { id: member.id }, data: { role } });
        await this.auditLog.write(tx, actor, 'PROJECT_ROLE_CHANGED', projectId, {
          userId: memberId,
          from: member.role,
          to: role,
        });
      });
      return member.role;
    });
    if (previous !== role) {
      // Open connections take the new role at once (an editor becoming reviewer stops writing).
      await this.events.publish({ type: 'project-access', projectId });
    }
    return this.sharing(actor.userId, projectId, actor.locale);
  }

  async removeMember(actor: Actor, projectId: string, memberId: string): Promise<ProjectSharing> {
    await this.projects.require(actor.userId, projectId, 'share');
    const db = this.prisma.client;
    const member = await db.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: memberId } },
    });
    if (!member) fail(HttpStatus.NOT_FOUND, 'not_found');
    await db.$transaction(async (tx) => {
      await tx.projectMember.delete({ where: { id: member!.id } });
      await this.auditLog.write(tx, actor, 'PROJECT_ACCESS_REMOVED', projectId, {
        userId: memberId,
        role: member!.role,
      });
    });
    await this.events.publish({ type: 'project-access', projectId });
    return this.sharing(actor.userId, projectId, actor.locale);
  }

  // ───────────── Invitation page ─────────────

  private async byToken(token: string) {
    const invitation = await this.prisma.client.projectInvitation.findUnique({
      where: { tokenHash: sha256(token) },
      include: {
        project: { select: { name: true, deletedAt: true, ownerId: true } },
        invitedBy: { select: { displayName: true } },
      },
    });
    // A project in the trash takes no new collaborator.
    if (!invitation || invitation.project.deletedAt)
      fail(HttpStatus.NOT_FOUND, 'invitation_invalid');
    return invitation!;
  }

  private statusOf(invitation: ProjectInvitation): InvitationView['status'] {
    return invitation.status === 'PENDING' && invitation.expiresAt <= new Date()
      ? 'EXPIRED'
      : invitation.status;
  }

  /** What the invitation page shows, read with the token (no session needed). */
  async view(token: string, ip: string | null): Promise<InvitationView> {
    await this.limitViews(token, ip);
    const invitation = await this.byToken(token);
    return {
      projectName: invitation.project.name,
      inviterName: invitation.invitedBy.displayName,
      role: invitation.role as ShareableRole,
      message: invitation.message,
      channel: invitation.phone ? 'phone' : 'email',
      contactHint: maskContact(invitation.phone ?? invitation.email ?? ''),
      status: this.statusOf(invitation),
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  /**
   * Readings of an invitation page: per token first, per address only as a high backstop (many
   * mobile users share one address). Guessing a token (32 random bytes) is hopeless anyway.
   */
  private async limitViews(token: string, ip: string | null): Promise<void> {
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
  }

  /** Accepting and declining, per signed-in account. */
  private limitActions(userId: string): Promise<void> {
    return consumeLimit(
      this.redis.client,
      `rl:invite-action:${userId}`,
      this.config.env.INVITATION_ACTIONS_PER_HOUR,
      3600,
    );
  }

  /**
   * Accepts with the signed-in account, which must be the one of the invited phone number or of
   * the invited e-mail address once verified: a forwarded link gives nothing to someone else.
   */
  async accept(user: User, token: string, ip: string | null): Promise<{ projectId: string }> {
    await this.limitActions(user.id);
    const invitation = await this.byToken(token);
    if (this.statusOf(invitation) !== 'PENDING') fail(HttpStatus.GONE, 'invitation_invalid');
    if (!this.isInvited(user, invitation)) fail(HttpStatus.FORBIDDEN, 'invitation_other_account');
    const { projectId } = invitation;
    const ownerId = invitation.project.ownerId;

    await this.projects.runLocked(ownerId, async () => {
      const db = this.prisma.client;
      const member =
        user.id === ownerId
          ? true
          : await db.projectMember.findUnique({
              where: { projectId_userId: { projectId, userId: user.id } },
            });
      if (!member && countsAsCollaborator(invitation.role)) {
        // The plan of the owner may have changed since the invitation was sent.
        await this.checkCollaborators(projectId, ownerId, { invitationId: invitation.id });
      }
      await db.$transaction(async (tx) => {
        const { count } = await tx.projectInvitation.updateMany({
          where: { id: invitation.id, status: 'PENDING' },
          data: { status: 'ACCEPTED', acceptedById: user.id, decidedAt: new Date() },
        });
        if (!count) fail(HttpStatus.GONE, 'invitation_invalid');
        // Already in the project (invited twice, by phone and by e-mail): the access stays.
        if (!member) {
          await tx.projectMember.create({
            data: { projectId, userId: user.id, role: invitation.role },
          });
        }
        await this.auditLog.write(
          tx,
          { userId: user.id, ip },
          member ? 'PROJECT_INVITATION_ACCEPTED' : 'PROJECT_SHARED',
          projectId,
          {
            invitationId: invitation.id,
            role: invitation.role,
            invitedById: invitation.invitedById,
          },
        );
      });
    });
    return { projectId };
  }

  /** The account of the invited phone number or e-mail address, verified. */
  private isInvited(user: User, invitation: ProjectInvitation): boolean {
    return invitation.phone
      ? user.phone === invitation.phone && user.phoneVerifiedAt !== null
      : user.email === invitation.email && user.emailVerifiedAt !== null;
  }

  async decline(user: User, token: string, ip: string | null): Promise<void> {
    await this.limitActions(user.id);
    const invitation = await this.byToken(token);
    if (!this.isInvited(user, invitation)) fail(HttpStatus.FORBIDDEN, 'invitation_other_account');
    await this.prisma.client.$transaction(async (tx) => {
      const { count } = await tx.projectInvitation.updateMany({
        where: { id: invitation.id, status: 'PENDING', expiresAt: { gt: new Date() } },
        data: { status: 'DECLINED', decidedAt: new Date() },
      });
      if (!count) fail(HttpStatus.GONE, 'invitation_invalid');
      await this.auditLog.write(
        tx,
        { userId: user.id, ip },
        'PROJECT_INVITATION_DECLINED',
        invitation.projectId,
        { invitationId: invitation.id },
      );
    });
  }
}
