import type { Invitation, User } from '@integris/db';
import {
  type ChosenKind,
  formatJoinCode,
  type JoinResult,
  maskContact,
  type MemberKindValue,
  type MembersPage,
  type MemberUsage,
  type MyJoinRequest,
  normalizePhone,
  ORG_INVITATION_TTL_DAYS,
  type OrganizationView,
  type OrgGroup,
  orgInviteSchema,
  updateMemberSchema,
  usagePeriodStart,
} from '@integris/shared';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes, randomInt } from 'node:crypto';
import type { z } from 'zod';
import { sha256 } from '../auth/keys.js';
import { consumeLimit } from '../common/rate-limit.js';
import { ApiConfig } from '../config/api-config.js';
import { MAIL_SENDER, type MailSender } from '../mail/mail-sender.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectEventsService } from '../projects/project-events.service.js';
import { isSubscriptionLive } from '../projects/quota.service.js';
import { revokeLostCoeditors } from '../exam-papers/exam-access.js';
import { RedisService } from '../redis/redis.service.js';
import { consumeSmsBudget } from '../sms/sms-budget.js';
import { SMS_SENDER, type SmsSender } from '../sms/sms-sender.js';
import {
  fail,
  type OrgActor,
  type OrgContext,
  OrgContextService,
  type Tx,
} from './org-context.service.js';
import { orgInvitationMail, orgInvitationSms } from './org-messages.js';
import { SeatsService } from './seats.service.js';
import { SupervisionService } from './supervision.service.js';

const DAY_MS = 86_400_000;
/** Join code attempts per account and hour (a code has 50 bits: guessing is hopeless anyway). */
const JOIN_ATTEMPTS_PER_HOUR = 10;
/** Join code attempts per address and hour (many accounts behind one mobile address). */
const JOIN_ATTEMPTS_PER_HOUR_PER_IP = 60;
/** Invitation SMS of an organization per UTC day: twice its seats, at least 20. */
const orgSmsPerDay = (seats: number) => Math.max(20, seats * 2);
/** Share of the platform SMS budget invitations may use: sign-in codes keep the rest. */
const INVITATION_SMS_SHARE = 0.7;
/** Revoked invitations per organization and hour (a revoked one gives its seat back at once). */
const REVOCATIONS_PER_HOUR = 60;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

type Invite = z.output<typeof orgInviteSchema>;
type MemberUpdate = z.output<typeof updateMemberSchema>;

/** Phone or e-mail of an invitation, normalized. */
export interface Contact {
  phone?: string;
  email?: string;
}

/** Signed-in user acting in an organization. */
export interface Actor extends OrgActor {
  userId: string;
}

export function newJoinCode(): string {
  return Array.from({ length: 10 }, () => CROCKFORD[randomInt(CROCKFORD.length)]).join('');
}

/**
 * Members of a TEAM or BUSINESS (docs/spec.md, "Plans, comptes et membres" and the step 12
 * decisions): invitations that reserve a seat, removal and departure (the seat waits 30 days),
 * admins (BUSINESS, owner only, at most the plan's `maxAdmins`), teachers' join requests confirmed
 * by an admin, groups ("Classes et filières") and the consumption of each member. The owner and
 * admins see members and counts, never project contents.
 */
@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgs: OrgContextService,
    private readonly seats: SeatsService,
    private readonly supervision: SupervisionService,
    private readonly events: ProjectEventsService,
    private readonly redis: RedisService,
    private readonly config: ApiConfig,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
  ) {}

  // ───────────── Reading ─────────────

  async view(userId: string, organizationId: string): Promise<OrganizationView> {
    const context = await this.orgs.load(userId, organizationId);
    const { organization, subscription, membership } = context;
    const db = this.prisma.client;
    const now = new Date();
    const business = organization.type === 'BUSINESS';
    let management: Pick<OrganizationView, 'seats' | 'admins' | 'joinCode' | 'counts'> = {
      seats: null,
      admins: null,
      joinCode: null,
      counts: null,
    };
    if (context.manages) {
      await this.seats.expireInvitations(organizationId, now);
      const [seats, memberships, invitations] = await Promise.all([
        this.seats.summary(subscription.id, now),
        db.membership.findMany({ where: { organizationId } }),
        db.invitation.count({ where: { organizationId, status: 'PENDING' } }),
      ]);
      const active = memberships.filter((row) => row.status === 'ACTIVE');
      management = {
        seats,
        admins: business
          ? {
              count: active.filter((row) => row.role === 'ADMIN').length,
              max: subscription.plan.maxAdmins,
            }
          : null,
        joinCode: business ? formatJoinCode(await this.ensureJoinCode(context)) : null,
        counts: {
          teachers: active.filter((row) => row.kind === 'TEACHER').length,
          students: active.filter((row) => row.kind === 'STUDENT').length,
          others: active.filter((row) => row.kind !== 'TEACHER' && row.kind !== 'STUDENT').length,
          joinRequests: memberships.filter(
            (row) =>
              row.status === 'PENDING_APPROVAL' ||
              (row.status === 'ACTIVE' && row.teacherRequestedAt !== null),
          ).length,
          invitations,
        },
      };
    }
    return {
      id: organization.id,
      name: organization.name,
      type: organization.type,
      me: {
        role: membership.role,
        kind: membership.kind,
        manages: context.manages,
        groupId: membership.groupId,
        teacherRequested: membership.teacherRequestedAt !== null,
      },
      membersChooseGroup: business && organization.membersChooseGroup,
      groups:
        business && (context.manages || organization.membersChooseGroup)
          ? await this.groups(organizationId)
          : null,
      subscription: {
        id: subscription.id,
        planCode: subscription.plan.code === 'TEAM' ? 'TEAM' : 'BUSINESS',
        live: isSubscriptionLive(subscription, now),
        periodEnd: subscription.currentPeriodEnd.toISOString(),
      },
      ...management,
      supervision: {
        enabled: business && subscription.plan.supervisionDashboard,
        maxStudents: subscription.plan.maxSupervisedStudents,
      },
    };
  }

  private async ensureJoinCode(context: OrgContext): Promise<string> {
    if (context.organization.joinCode) return context.organization.joinCode;
    return this.writeJoinCode(context, { userId: null, ip: null }, 'created');
  }

  private async writeJoinCode(
    context: OrgContext,
    actor: OrgActor,
    reason: 'created' | 'regenerated',
  ): Promise<string> {
    const code = newJoinCode();
    await this.prisma.client.$transaction(async (tx) => {
      await tx.organization.update({
        where: { id: context.organization.id },
        data: { joinCode: code },
      });
      await this.orgs.audit(
        tx,
        actor,
        'ORG_JOIN_CODE_CHANGED',
        'Organization',
        context.organization.id,
        { reason },
      );
    });
    return code;
  }

  async regenerateJoinCode(actor: Actor, organizationId: string): Promise<OrganizationView> {
    const context = await this.orgs.manager(actor.userId, organizationId);
    this.orgs.requireBusiness(context);
    await this.writeJoinCode(context, actor, 'regenerated');
    return this.view(actor.userId, organizationId);
  }

  async members(userId: string, organizationId: string): Promise<MembersPage> {
    const context = await this.orgs.manager(userId, organizationId);
    const db = this.prisma.client;
    const now = new Date();
    await this.seats.expireInvitations(organizationId, now);
    const [memberships, invitations, groups, seats] = await Promise.all([
      db.membership.findMany({
        where: { organizationId },
        include: {
          user: { select: { displayName: true, phone: true, email: true } },
          secretariatScopes: { select: { groupId: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      db.invitation.findMany({
        where: { organizationId, status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
      }),
      this.groups(organizationId),
      this.seats.summary(context.subscription.id, now),
    ]);
    const active = memberships.filter((row) => row.status === 'ACTIVE');
    const usage = await this.usageOf(
      active.map((row) => row.userId),
      now,
    );
    const hint = (user: { phone: string | null; email: string | null }) =>
      user.phone || user.email ? maskContact(user.phone ?? user.email!) : null;
    return {
      members: active.map((row) => ({
        userId: row.userId,
        name: row.user.displayName,
        contactHint: hint(row.user),
        role: row.role,
        kind: row.kind,
        groupId: row.groupId,
        scopeGroupIds: row.secretariatScopes.map((scope) => scope.groupId),
        joinedAt: (row.approvedAt ?? row.createdAt).toISOString(),
        usage: usage.get(row.userId)!,
      })),
      invitations: invitations.map((row) => ({
        id: row.id,
        channel: row.phone ? 'phone' : 'email',
        contact: row.phone ?? row.email ?? '',
        displayName: row.displayName,
        kind: row.kind,
        groupId: row.groupId,
        scopeGroupIds: row.scopeGroupIds,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      })),
      joinRequests: memberships
        .filter(
          (row) =>
            row.status === 'PENDING_APPROVAL' ||
            (row.status === 'ACTIVE' && row.teacherRequestedAt !== null),
        )
        .map((row) => ({
          userId: row.userId,
          name: row.user.displayName,
          type: row.status === 'ACTIVE' ? ('teacher' as const) : ('join' as const),
          contactHint: hint(row.user),
          requestedAt: (row.teacherRequestedAt ?? row.createdAt).toISOString(),
        })),
      groups,
      seats,
    };
  }

  /**
   * Consumption of the month per member: projects, storage, compilations and their minutes.
   * Counts only: the names and contents of the projects are never read here.
   */
  private async usageOf(userIds: string[], now: Date): Promise<Map<string, MemberUsage>> {
    const db = this.prisma.client;
    const usage = new Map<string, MemberUsage>(
      userIds.map((id) => [id, { projects: 0, storageBytes: 0, compiles: 0, compileSeconds: 0 }]),
    );
    if (!userIds.length) return usage;
    const [projects, counters] = await Promise.all([
      db.project.findMany({
        where: { ownerId: { in: userIds } },
        select: { id: true, ownerId: true, deletedAt: true },
      }),
      db.usageCounter.findMany({
        where: { userId: { in: userIds }, periodStart: usagePeriodStart(now) },
      }),
    ]);
    const ownerOf = new Map(projects.map((project) => [project.id, project.ownerId]));
    for (const project of projects) {
      if (!project.deletedAt) usage.get(project.ownerId)!.projects++;
    }
    // Storage counts the trash too, like the quota.
    const sizes = projects.length
      ? await db.projectFile.groupBy({
          by: ['projectId'],
          where: { projectId: { in: projects.map((project) => project.id) } },
          _sum: { sizeBytes: true },
        })
      : [];
    for (const row of sizes) {
      usage.get(ownerOf.get(row.projectId)!)!.storageBytes += row._sum.sizeBytes ?? 0;
    }
    for (const counter of counters) {
      const entry = usage.get(counter.userId)!;
      entry.compiles = counter.compileCount;
      entry.compileSeconds = counter.compileSeconds;
    }
    return usage;
  }

  // ───────────── Invitations ─────────────

  /** Phone (the first allowed country when typed without one: CSV lines) or e-mail address. */
  contactOf(body: {
    channel: 'phone' | 'email';
    phone?: string;
    dialCode?: string;
    email?: string;
  }): Contact {
    if (body.channel === 'email') return { email: body.email! };
    const allowed = this.config.env.AUTH_ALLOWED_DIAL_CODES;
    const phone = normalizePhone(body.phone ?? '', body.dialCode ?? allowed[0]);
    if (!phone) return fail(HttpStatus.BAD_REQUEST, 'invalid_contact');
    if (!allowed.some((code) => phone.startsWith(`+${code}`))) {
      return fail(HttpStatus.BAD_REQUEST, 'country_not_allowed');
    }
    return { phone };
  }

  /**
   * Kind of a new member: STUDENT, TEACHER or SECRETARY in a BUSINESS (student by default), none
   * in a TEAM.
   */
  private kindOf(context: OrgContext, kind: ChosenKind | undefined): MemberKindValue {
    if (kind !== undefined && kind !== 'STUDENT') this.orgs.requireBusiness(context);
    return context.organization.type === 'BUSINESS' ? (kind ?? 'STUDENT') : 'OTHER';
  }

  /**
   * Groups served by a secretariat (docs/spec.md, "Devoirs et secrétariat"): at least one, all of
   * this organization. Null for any other kind (the groups given are then ignored).
   */
  private async checkScopes(
    context: OrgContext,
    kind: MemberKindValue,
    groupIds: string[] | undefined,
  ): Promise<string[] | null> {
    if (kind !== 'SECRETARY') return null;
    const ids = [...new Set(groupIds ?? [])];
    if (!ids.length) return fail(HttpStatus.BAD_REQUEST, 'secretary_groups_required');
    const found = await this.prisma.client.orgGroup.count({
      where: { id: { in: ids }, organizationId: context.organization.id },
    });
    return found === ids.length ? ids : fail(HttpStatus.NOT_FOUND, 'group_not_found');
  }

  /** Replaces the groups a secretariat membership serves. */
  private async writeScopes(tx: Tx, membershipId: string, groupIds: string[]): Promise<void> {
    await tx.secretariatScope.deleteMany({ where: { membershipId } });
    if (groupIds.length) {
      await tx.secretariatScope.createMany({
        data: groupIds.map((groupId) => ({ membershipId, groupId })),
      });
    }
  }

  private async checkGroup(context: OrgContext, groupId: string | null | undefined) {
    if (!groupId) return null;
    this.orgs.requireBusiness(context);
    const group = await this.prisma.client.orgGroup.findFirst({
      where: { id: groupId, organizationId: context.organization.id },
    });
    return group ? group.id : fail(HttpStatus.NOT_FOUND, 'group_not_found');
  }

  /**
   * Why this contact cannot be invited (already a member, a pending join request or a pending
   * invitation), or null. Expired invitations were marked first.
   */
  async refusalFor(tx: Tx, organizationId: string, contact: Contact) {
    const user = await tx.user.findFirst({
      where: contact.phone ? { phone: contact.phone } : { email: contact.email },
      select: { id: true },
    });
    if (user) {
      const membership = await tx.membership.findFirst({
        where: { organizationId, userId: user.id },
      });
      if (membership?.status === 'ACTIVE') return 'already_member' as const;
      if (membership?.status === 'PENDING_APPROVAL') return 'join_pending' as const;
    }
    const pending = await tx.invitation.findFirst({
      where: {
        organizationId,
        status: 'PENDING',
        ...(contact.phone ? { phone: contact.phone } : { email: contact.email }),
      },
    });
    return pending ? ('already_invited' as const) : null;
  }

  /**
   * Writes an invitation with its reserved seat (inside the caller's transaction, under the
   * organization lock). Returns the invitation and its token.
   */
  async createInvitation(
    tx: Tx,
    actor: Actor,
    context: OrgContext,
    input: {
      contact: Contact;
      kind: MemberKindValue;
      groupId: string | null;
      /** SECRETARY: groups to serve once the invitation is accepted. */
      scopeGroupIds?: string[];
      displayName?: string | null;
      importId?: string | null;
      locale: 'fr' | 'en';
    },
    now: Date,
  ): Promise<{ invitation: Invitation; token: string }> {
    const token = randomBytes(32).toString('base64url');
    const invitation = await tx.invitation.create({
      data: {
        organizationId: context.organization.id,
        invitedById: actor.userId,
        phone: input.contact.phone ?? null,
        email: input.contact.email ?? null,
        role: 'MEMBER',
        kind: input.kind,
        groupId: input.groupId,
        scopeGroupIds: input.scopeGroupIds ?? [],
        displayName: input.displayName ?? null,
        importId: input.importId ?? null,
        locale: input.locale,
        tokenHash: sha256(token),
        expiresAt: new Date(now.getTime() + ORG_INVITATION_TTL_DAYS * DAY_MS),
      },
    });
    await this.seats.reserve(tx, actor, context.subscription.id, invitation.id, now);
    await this.orgs.audit(
      tx,
      actor,
      'ORG_INVITATION_SENT',
      'Organization',
      context.organization.id,
      {
        invitationId: invitation.id,
        kind: input.kind,
        channel: input.contact.phone ? 'phone' : 'email',
        ...(input.groupId ? { groupId: input.groupId } : {}),
        ...(input.importId ? { importId: input.importId } : {}),
      },
    );
    return { invitation, token };
  }

  /** Sends the SMS or e-mail of an invitation. Throws when the message could not leave. */
  async sendInvitation(
    inviter: User,
    context: OrgContext,
    contact: Contact,
    token: string,
  ): Promise<void> {
    const locale = inviter.locale;
    const organizationName = context.organization.name;
    const link = `${this.config.env.PUBLIC_WEB_URL.replace(/\/+$/, '')}/${locale}/join#token=${token}`;
    if (contact.phone) {
      // One organization cannot spend the SMS budget of the platform (codes keep their share).
      await consumeLimit(
        this.redis.client,
        `rl:org-sms:${context.organization.id}:${new Date().toISOString().slice(0, 10)}`,
        orgSmsPerDay(context.subscription.seatCount),
        2 * 86_400,
      );
      await consumeSmsBudget(
        this.redis.client,
        this.config.env.SMS_DAILY_LIMIT,
        this.logger,
        INVITATION_SMS_SHARE,
      );
      await this.sms.send(contact.phone, orgInvitationSms[locale](link, ORG_INVITATION_TTL_DAYS));
    } else {
      await this.mail.send(
        orgInvitationMail[locale]({
          to: contact.email!,
          inviterName: inviter.displayName,
          organizationName,
          link,
          days: ORG_INVITATION_TTL_DAYS,
        }),
      );
    }
  }

  /** An invitation whose message could not be sent does not keep its seat. */
  async cancelUnsent(actor: Actor, organizationId: string, invitationId: string): Promise<void> {
    await this.prisma.client.$transaction(async (tx) => {
      await tx.invitation.update({
        where: { id: invitationId },
        data: { status: 'REVOKED', decidedAt: new Date() },
      });
      await this.seats.unreserve(tx, actor, [invitationId], 'not_sent');
      await this.orgs.audit(tx, actor, 'ORG_INVITATION_REVOKED', 'Organization', organizationId, {
        invitationId,
        reason: 'not_sent',
      });
    });
  }

  async invite(user: User, organizationId: string, body: Invite, ip: string | null) {
    const actor: Actor = { userId: user.id, ip };
    const context = await this.orgs.manager(user.id, organizationId);
    this.orgs.requireLive(context);
    const contact = this.contactOf(body);
    if (contact.phone ? contact.phone === user.phone : contact.email === user.email) {
      fail(HttpStatus.CONFLICT, 'cannot_invite_self');
    }
    const kind = this.kindOf(context, body.kind);
    const groupId = await this.checkGroup(context, body.groupId);
    const scopeGroupIds = (await this.checkScopes(context, kind, body.scopeGroupIds)) ?? [];
    await consumeLimit(
      this.redis.client,
      `rl:org-invite:${user.id}:${new Date().toISOString().slice(0, 10)}`,
      this.config.env.SHARE_INVITATIONS_PER_DAY,
      2 * 86_400,
    );
    const { invitation, token } = await this.orgs.locked(organizationId, async () => {
      const now = new Date();
      await this.seats.expireInvitations(organizationId, now);
      return this.prisma.client.$transaction(async (tx) => {
        const refusal = await this.refusalFor(tx, organizationId, contact);
        if (refusal === 'already_member') fail(HttpStatus.CONFLICT, 'already_org_member');
        if (refusal === 'join_pending') fail(HttpStatus.CONFLICT, 'join_pending');
        if (refusal === 'already_invited') fail(HttpStatus.CONFLICT, 'already_org_invited');
        return this.createInvitation(
          tx,
          actor,
          context,
          { contact, kind, groupId, scopeGroupIds, locale: user.locale },
          now,
        );
      });
    });
    try {
      await this.sendInvitation(user, context, contact, token);
    } catch (error) {
      await this.cancelUnsent(actor, organizationId, invitation.id);
      throw error;
    }
    return this.members(user.id, organizationId);
  }

  async revokeInvitation(actor: Actor, organizationId: string, invitationId: string) {
    await this.orgs.manager(actor.userId, organizationId);
    await consumeLimit(
      this.redis.client,
      `rl:org-revoke:${organizationId}`,
      REVOCATIONS_PER_HOUR,
      3600,
    );
    await this.orgs.locked(organizationId, () =>
      this.prisma.client.$transaction(async (tx) => {
        const { count } = await tx.invitation.updateMany({
          where: { id: invitationId, organizationId, status: 'PENDING' },
          data: { status: 'REVOKED', decidedAt: new Date() },
        });
        if (!count) fail(HttpStatus.NOT_FOUND, 'invitation_invalid');
        await this.seats.unreserve(tx, actor, [invitationId], 'revoked');
        await this.orgs.audit(tx, actor, 'ORG_INVITATION_REVOKED', 'Organization', organizationId, {
          invitationId,
        });
      }),
    );
    return this.members(actor.userId, organizationId);
  }

  // ───────────── Members ─────────────

  async updateMember(
    actor: Actor,
    organizationId: string,
    userId: string,
    body: MemberUpdate,
  ): Promise<MembersPage> {
    const context = await this.orgs.manager(actor.userId, organizationId);
    if (body.admin !== undefined) {
      // Only the owner delegates to admins (docs/spec.md, "Le titulaire occupe un siège").
      if (!context.isOwner) fail(HttpStatus.FORBIDDEN, 'org_forbidden');
      this.orgs.requireBusiness(context);
    }
    if (body.kind !== undefined || body.scopeGroupIds !== undefined) {
      this.orgs.requireBusiness(context);
    }
    const groupId =
      body.groupId === undefined ? undefined : await this.checkGroup(context, body.groupId);
    const current = await this.prisma.client.membership.findFirst({
      where: { organizationId, userId, status: 'ACTIVE' },
      include: { secretariatScopes: { select: { groupId: true } } },
    });
    if (!current) return fail(HttpStatus.NOT_FOUND, 'member_not_found');
    const nextKind = body.kind ?? current.kind;
    // A secretariat keeps its groups unless new ones are given.
    const scopeGroupIds =
      body.scopeGroupIds !== undefined ||
      (body.kind === 'SECRETARY' && current.kind !== 'SECRETARY')
        ? await this.checkScopes(context, nextKind, body.scopeGroupIds)
        : null;
    const projects = await this.orgs.locked(organizationId, () =>
      this.prisma.client.$transaction(async (tx) => {
        const member = await tx.membership.findFirst({
          where: { organizationId, userId, status: 'ACTIVE' },
        });
        if (!member) return fail(HttpStatus.NOT_FOUND, 'member_not_found');
        // Only the owner changes the owner or an admin (their profile and group too).
        if (!context.isOwner && (member.role === 'OWNER' || member.role === 'ADMIN')) {
          fail(HttpStatus.FORBIDDEN, 'org_forbidden');
        }
        // Nobody raises their own role: a teacher's profile comes from a confirmed join request,
        // the admin role from the owner. The owner alone may give themself the teacher profile.
        if (
          userId === actor.userId &&
          !context.isOwner &&
          body.kind === 'TEACHER' &&
          member.kind !== 'TEACHER'
        ) {
          fail(HttpStatus.FORBIDDEN, 'org_forbidden');
        }
        // Nobody, the owner included, gives themself the secretariat profile or its groups: it
        // opens exam subjects, which the owner never sees (step 13 decisions).
        if (
          userId === actor.userId &&
          ((body.kind === 'SECRETARY' && member.kind !== 'SECRETARY') ||
            body.scopeGroupIds !== undefined)
        ) {
          fail(HttpStatus.FORBIDDEN, 'org_forbidden');
        }
        // The owner and the admins never hold the secretariat profile, which opens exam subjects
        // (step 13 decisions): refused both ways, whatever is changed first.
        const nextRole =
          body.admin === undefined || member.role === 'OWNER'
            ? member.role
            : body.admin
              ? 'ADMIN'
              : 'MEMBER';
        if ((body.kind ?? member.kind) === 'SECRETARY' && nextRole !== 'MEMBER') {
          fail(HttpStatus.CONFLICT, 'secretary_admin');
        }
        const ended: string[] = [];
        if (body.admin !== undefined && (member.role === 'ADMIN') !== body.admin) {
          if (member.role === 'OWNER') fail(HttpStatus.CONFLICT, 'cannot_remove_owner');
          if (body.admin) {
            const admins = await tx.membership.count({
              where: { organizationId, role: 'ADMIN', status: 'ACTIVE' },
            });
            if (admins >= context.subscription.plan.maxAdmins) {
              fail(HttpStatus.CONFLICT, 'admin_limit');
            }
          }
          const role = body.admin ? 'ADMIN' : 'MEMBER';
          await tx.membership.update({ where: { id: member.id }, data: { role } });
          await this.orgs.audit(tx, actor, 'ORG_ROLE_CHANGED', 'Organization', organizationId, {
            userId,
            from: member.role,
            to: role,
          });
        }
        if (body.kind !== undefined && body.kind !== member.kind) {
          await tx.membership.update({
            where: { id: member.id },
            data: { kind: body.kind, teacherRequestedAt: null },
          });
          await this.orgs.audit(
            tx,
            actor,
            'ORG_MEMBER_KIND_CHANGED',
            'Organization',
            organizationId,
            {
              userId,
              from: member.kind,
              to: body.kind,
            },
          );
          // A former secretariat serves no group; a former teacher co-edits no exam paper.
          if (member.kind === 'SECRETARY') await this.writeScopes(tx, member.id, []);
          if (member.kind === 'TEACHER') {
            ended.push(
              ...(await revokeLostCoeditors(tx, actor, organizationId, userId, 'kind_changed')),
            );
          }
          // Links that no longer fit the member's kind end (a former teacher supervises no one).
          ended.push(
            ...(await this.supervision.endLinks(
              tx,
              actor,
              {
                organizationId,
                ...(member.kind === 'TEACHER' ? { supervisorId: userId } : { studentId: userId }),
              },
              'kind_changed',
            )),
          );
        }
        if (scopeGroupIds) {
          const before = current.secretariatScopes.map((scope) => scope.groupId).sort();
          if (before.join() !== [...scopeGroupIds].sort().join()) {
            await this.writeScopes(tx, member.id, scopeGroupIds);
            await this.orgs.audit(
              tx,
              actor,
              'ORG_SECRETARY_GROUPS_CHANGED',
              'Organization',
              organizationId,
              { userId, from: before, to: scopeGroupIds },
            );
          }
        }
        if (groupId !== undefined && groupId !== member.groupId) {
          await tx.membership.update({ where: { id: member.id }, data: { groupId } });
          await this.orgs.audit(
            tx,
            actor,
            'ORG_MEMBER_GROUP_CHANGED',
            'Organization',
            organizationId,
            {
              userId,
              from: member.groupId,
              to: groupId,
            },
          );
        }
        return ended;
      }),
    );
    await this.supervision.accessChanged(projects);
    return this.members(actor.userId, organizationId);
  }

  /** Removal by the owner or an admin (an admin removes neither the owner nor another admin). */
  async removeMember(actor: Actor, organizationId: string, userId: string): Promise<MembersPage> {
    const context = await this.orgs.manager(actor.userId, organizationId);
    if (userId === actor.userId) return fail(HttpStatus.CONFLICT, 'owner_cannot_leave');
    await this.depart(actor, context, userId, 'ORG_MEMBER_REMOVED');
    return this.members(actor.userId, organizationId);
  }

  /** Any member but the owner leaves: same effects as a removal. */
  async leave(actor: Actor, organizationId: string): Promise<void> {
    const context = await this.orgs.load(actor.userId, organizationId);
    if (context.isOwner) fail(HttpStatus.CONFLICT, 'owner_cannot_leave');
    await this.depart(actor, context, actor.userId, 'ORG_MEMBER_LEFT');
  }

  /**
   * A member goes: their membership ends, their seat is released (reassignable 30 days later),
   * their supervision links of this organization end. They keep their account and projects.
   */
  private async depart(
    actor: Actor,
    context: OrgContext,
    userId: string,
    action: 'ORG_MEMBER_REMOVED' | 'ORG_MEMBER_LEFT',
  ): Promise<void> {
    const organizationId = context.organization.id;
    const projects = await this.orgs.locked(organizationId, () =>
      this.prisma.client.$transaction(async (tx) => {
        const member = await tx.membership.findFirst({
          where: { organizationId, userId, status: 'ACTIVE' },
        });
        if (!member) return fail(HttpStatus.NOT_FOUND, 'member_not_found');
        if (member.role === 'OWNER') fail(HttpStatus.CONFLICT, 'cannot_remove_owner');
        if (action === 'ORG_MEMBER_REMOVED' && member.role === 'ADMIN' && !context.isOwner) {
          fail(HttpStatus.FORBIDDEN, 'org_forbidden');
        }
        const now = new Date();
        const ended = [
          ...(await this.supervision.endLinks(
            tx,
            actor,
            { organizationId, supervisorId: userId },
            'member_left',
          )),
          ...(await this.supervision.endLinks(
            tx,
            actor,
            { organizationId, studentId: userId },
            'member_left',
          )),
        ];
        await tx.secretariatScope.deleteMany({ where: { membershipId: member.id } });
        await tx.membership.delete({ where: { id: member.id } });
        // Exam papers co-edited through this organization only are closed to the co-editors.
        ended.push(
          ...(await revokeLostCoeditors(tx, actor, organizationId, userId, 'member_left')),
        );
        await this.seats.release(tx, actor, context.subscription.id, userId, now, action);
        await this.orgs.audit(tx, actor, action, 'Organization', organizationId, {
          userId,
          role: member.role,
          kind: member.kind,
        });
        return ended;
      }),
    );
    await this.supervision.accessChanged(projects);
    await this.seats.applied([userId]);
  }

  // ───────────── Join requests (teachers of a BUSINESS) ─────────────

  /** A signed-in teacher types the join code of a BUSINESS: the request waits for an admin. */
  async join(user: User, code: string, ip: string | null): Promise<JoinResult> {
    await consumeLimit(this.redis.client, `rl:org-join:${user.id}`, JOIN_ATTEMPTS_PER_HOUR, 3600);
    await consumeLimit(
      this.redis.client,
      `rl:org-join:ip:${sha256(ip ?? 'unknown')}`,
      JOIN_ATTEMPTS_PER_HOUR_PER_IP,
      3600,
    );
    const db = this.prisma.client;
    const organization = await db.organization.findFirst({
      where: { joinCode: code, type: 'BUSINESS' },
    });
    if (!organization) return fail(HttpStatus.NOT_FOUND, 'join_code_invalid');
    const existing = await db.membership.findFirst({
      where: { organizationId: organization.id, userId: user.id },
    });
    if (existing?.status === 'ACTIVE') {
      // A member asks to become a teacher: they keep their seat and profile until an admin
      // confirms (nobody raises their own role).
      if (existing.kind === 'TEACHER') fail(HttpStatus.CONFLICT, 'already_org_member');
      await db.$transaction(async (tx) => {
        const { count } = await tx.membership.updateMany({
          where: { id: existing.id, status: 'ACTIVE', teacherRequestedAt: null },
          data: { teacherRequestedAt: new Date() },
        });
        if (!count) fail(HttpStatus.CONFLICT, 'join_pending');
        await this.orgs.audit(
          tx,
          { userId: user.id, ip },
          'ORG_TEACHER_REQUESTED',
          'Organization',
          organization.id,
          { userId: user.id, kind: existing.kind },
        );
        await this.notifyManagers(tx, organization.id, 'ORG_TEACHER_REQUESTED', user);
      });
      return { organizationName: organization.name, status: 'PENDING_APPROVAL' };
    }
    if (existing?.status === 'PENDING_APPROVAL') fail(HttpStatus.CONFLICT, 'join_pending');
    // Two requests sent together: the unique key keeps one, the other is told it is pending.
    await db
      .$transaction(async (tx) => {
        if (existing) await tx.membership.delete({ where: { id: existing.id } });
        await tx.membership.create({
          data: {
            organizationId: organization.id,
            userId: user.id,
            role: 'MEMBER',
            kind: 'TEACHER',
            status: 'PENDING_APPROVAL',
          },
        });
        await this.orgs.audit(
          tx,
          { userId: user.id, ip },
          'ORG_JOIN_REQUESTED',
          'Organization',
          organization.id,
          {
            userId: user.id,
          },
        );
        await this.notifyManagers(tx, organization.id, 'ORG_JOIN_REQUESTED', user);
      })
      .catch((error: unknown) => {
        if ((error as { code?: string }).code === 'P2002')
          fail(HttpStatus.CONFLICT, 'join_pending');
        throw error;
      });
    return { organizationName: organization.name, status: 'PENDING_APPROVAL' };
  }

  private async notifyManagers(tx: Tx, organizationId: string, type: string, user: User) {
    const managers = await tx.membership.findMany({
      where: { organizationId, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } },
    });
    await tx.notification.createMany({
      data: managers.map((manager) => ({
        userId: manager.userId,
        channel: 'IN_APP' as const,
        type,
        payload: { organizationId, userId: user.id, name: user.displayName },
      })),
    });
  }

  async myJoinRequests(userId: string): Promise<MyJoinRequest[]> {
    const rows = await this.prisma.client.membership.findMany({
      where: {
        userId,
        OR: [
          { status: 'PENDING_APPROVAL' },
          { status: 'ACTIVE', teacherRequestedAt: { not: null } },
        ],
      },
      include: { organization: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      organizationId: row.organizationId,
      organizationName: row.organization.name,
      requestedAt: (row.teacherRequestedAt ?? row.createdAt).toISOString(),
    }));
  }

  /**
   * A request of the owner or an admin is confirmed by the owner only, and never by its author
   * (nobody raises their own role).
   */
  private checkApprover(
    context: OrgContext,
    actor: Actor,
    request: { role: string; userId: string },
  ) {
    if (context.isOwner) return;
    if (request.role === 'OWNER' || request.role === 'ADMIN' || request.userId === actor.userId) {
      fail(HttpStatus.FORBIDDEN, 'org_forbidden');
    }
  }

  /**
   * Confirms a request: a teacher joining takes a free seat (402 `no_free_seat` otherwise); a
   * student member asking to become a teacher keeps their seat and gets the teacher profile
   * (their links as a student end).
   */
  async approve(
    actor: Actor,
    organizationId: string,
    userId: string,
    groupInput: string | null | undefined,
  ): Promise<MembersPage> {
    const context = await this.orgs.manager(actor.userId, organizationId);
    this.orgs.requireLive(context);
    const groupId = await this.checkGroup(context, groupInput);
    const projects = await this.orgs.locked(organizationId, () =>
      this.prisma.client.$transaction(async (tx) => {
        const now = new Date();
        const request = await tx.membership.findFirst({
          where: {
            organizationId,
            userId,
            OR: [
              { status: 'PENDING_APPROVAL' },
              { status: 'ACTIVE', teacherRequestedAt: { not: null } },
            ],
          },
        });
        if (!request) return fail(HttpStatus.NOT_FOUND, 'member_not_found');
        this.checkApprover(context, actor, request);
        let ended: string[] = [];
        if (request.status === 'ACTIVE') {
          if (request.kind === 'SECRETARY') await this.writeScopes(tx, request.id, []);
          await tx.membership.update({
            where: { id: request.id },
            data: {
              kind: 'TEACHER',
              teacherRequestedAt: null,
              ...(groupInput !== undefined ? { groupId } : {}),
            },
          });
          ended = await this.supervision.endLinks(
            tx,
            actor,
            { organizationId, studentId: userId },
            'kind_changed',
          );
          await this.orgs.audit(
            tx,
            actor,
            'ORG_MEMBER_KIND_CHANGED',
            'Organization',
            organizationId,
            {
              userId,
              from: request.kind,
              to: 'TEACHER',
              request: true,
            },
          );
        } else {
          await this.seats.assign(tx, actor, context.subscription.id, userId, now);
          await tx.membership.update({
            where: { id: request.id },
            data: { status: 'ACTIVE', approvedById: actor.userId, approvedAt: now, groupId },
          });
        }
        await this.orgs.audit(tx, actor, 'ORG_JOIN_APPROVED', 'Organization', organizationId, {
          userId,
          kind: 'TEACHER',
          type: request.status === 'ACTIVE' ? 'teacher' : 'join',
          ...(groupId ? { groupId } : {}),
        });
        await tx.notification.create({
          data: {
            userId,
            channel: 'IN_APP',
            type: 'ORG_JOIN_APPROVED',
            payload: { organizationId, name: context.organization.name },
          },
        });
        return ended;
      }),
    );
    await this.supervision.accessChanged(projects);
    await this.seats.applied([userId]);
    return this.members(actor.userId, organizationId);
  }

  /**
   * Refuses a request: a joining teacher's is deleted (they may ask again); a member's request to
   * become a teacher is dropped, they stay as they were.
   */
  async reject(actor: Actor, organizationId: string, userId: string): Promise<MembersPage> {
    const context = await this.orgs.manager(actor.userId, organizationId);
    await this.prisma.client.$transaction(async (tx) => {
      const request = await tx.membership.findFirst({
        where: {
          organizationId,
          userId,
          OR: [
            { status: 'PENDING_APPROVAL' },
            { status: 'ACTIVE', teacherRequestedAt: { not: null } },
          ],
        },
      });
      if (!request) return fail(HttpStatus.NOT_FOUND, 'member_not_found');
      this.checkApprover(context, actor, request);
      if (request.status === 'ACTIVE') {
        await tx.membership.update({
          where: { id: request.id },
          data: { teacherRequestedAt: null },
        });
      } else {
        await tx.membership.delete({ where: { id: request.id } });
      }
      await this.orgs.audit(tx, actor, 'ORG_JOIN_REJECTED', 'Organization', organizationId, {
        userId,
        type: request.status === 'ACTIVE' ? 'teacher' : 'join',
      });
      await tx.notification.create({
        data: {
          userId,
          channel: 'IN_APP',
          type: 'ORG_JOIN_REJECTED',
          payload: { organizationId, name: context.organization.name },
        },
      });
    });
    return this.members(actor.userId, organizationId);
  }

  // ───────────── Settings and own group ─────────────

  /** BUSINESS settings, changed by the owner or an admin. */
  async updateSettings(
    actor: Actor,
    organizationId: string,
    body: { membersChooseGroup: boolean },
  ): Promise<OrganizationView> {
    const context = await this.orgs.manager(actor.userId, organizationId);
    this.orgs.requireBusiness(context);
    if (context.organization.membersChooseGroup !== body.membersChooseGroup) {
      await this.prisma.client.$transaction(async (tx) => {
        await tx.organization.update({
          where: { id: organizationId },
          data: { membersChooseGroup: body.membersChooseGroup },
        });
        await this.orgs.audit(tx, actor, 'ORG_SETTINGS_CHANGED', 'Organization', organizationId, {
          membersChooseGroup: body.membersChooseGroup,
        });
      });
    }
    return this.view(actor.userId, organizationId);
  }

  /** A member chooses their own group, only when the organization allows it. */
  async chooseGroup(
    actor: Actor,
    organizationId: string,
    groupInput: string | null,
  ): Promise<OrganizationView> {
    const context = await this.orgs.load(actor.userId, organizationId);
    this.orgs.requireBusiness(context);
    if (!context.organization.membersChooseGroup) fail(HttpStatus.FORBIDDEN, 'org_forbidden');
    const groupId = await this.checkGroup(context, groupInput);
    const member = context.membership;
    if (member.groupId !== groupId) {
      await this.prisma.client.$transaction(async (tx) => {
        await tx.membership.update({ where: { id: member.id }, data: { groupId } });
        await this.orgs.audit(
          tx,
          actor,
          'ORG_MEMBER_GROUP_CHANGED',
          'Organization',
          organizationId,
          {
            userId: actor.userId,
            from: member.groupId,
            to: groupId,
            self: true,
          },
        );
      });
    }
    return this.view(actor.userId, organizationId);
  }

  // ───────────── Groups ("Classes et filières") ─────────────

  async groups(organizationId: string): Promise<OrgGroup[]> {
    const db = this.prisma.client;
    const [groups, memberships] = await Promise.all([
      db.orgGroup.findMany({ where: { organizationId }, orderBy: { name: 'asc' } }),
      db.membership.findMany({
        where: { organizationId, status: 'ACTIVE', groupId: { not: null } },
        select: { groupId: true },
      }),
    ]);
    return groups.map((group) => ({
      id: group.id,
      name: group.name,
      parentId: group.parentId,
      members: memberships.filter((row) => row.groupId === group.id).length,
    }));
  }

  private async checkGroupName(
    tx: Tx,
    organizationId: string,
    name: string,
    parentId: string | null,
    except?: string,
  ): Promise<void> {
    const same = await tx.orgGroup.findMany({ where: { organizationId, parentId } });
    if (
      same.some((group) => group.id !== except && group.name.toLowerCase() === name.toLowerCase())
    ) {
      fail(HttpStatus.CONFLICT, 'group_name_taken');
    }
  }

  async createGroup(
    actor: Actor,
    organizationId: string,
    body: { name: string; parentId?: string | null },
  ): Promise<OrgGroup[]> {
    const context = await this.orgs.manager(actor.userId, organizationId);
    this.orgs.requireBusiness(context);
    const parentId = await this.checkGroup(context, body.parentId);
    await this.prisma.client.$transaction(async (tx) => {
      await this.checkGroupName(tx, organizationId, body.name, parentId);
      const group = await tx.orgGroup.create({
        data: { organizationId, name: body.name, parentId },
      });
      await this.orgs.audit(tx, actor, 'ORG_GROUP_CREATED', 'OrgGroup', group.id, {
        organizationId,
        name: body.name,
        parentId,
      });
    });
    return this.groups(organizationId);
  }

  async updateGroup(
    actor: Actor,
    organizationId: string,
    groupId: string,
    body: { name: string; parentId?: string | null },
  ): Promise<OrgGroup[]> {
    const context = await this.orgs.manager(actor.userId, organizationId);
    this.orgs.requireBusiness(context);
    await this.checkGroup(context, groupId);
    const parentId =
      body.parentId === undefined ? undefined : await this.checkGroup(context, body.parentId);
    await this.prisma.client.$transaction(async (tx) => {
      const group = await tx.orgGroup.findUniqueOrThrow({ where: { id: groupId } });
      const parent = parentId === undefined ? group.parentId : parentId;
      // A group never goes under itself or one of its descendants.
      for (let cursor = parent; cursor;) {
        if (cursor === groupId) fail(HttpStatus.CONFLICT, 'group_cycle');
        cursor = (await tx.orgGroup.findUnique({ where: { id: cursor } }))?.parentId ?? null;
      }
      await this.checkGroupName(tx, organizationId, body.name, parent, groupId);
      await tx.orgGroup.update({
        where: { id: groupId },
        data: { name: body.name, parentId: parent },
      });
      await this.orgs.audit(tx, actor, 'ORG_GROUP_UPDATED', 'OrgGroup', groupId, {
        organizationId,
        from: { name: group.name, parentId: group.parentId },
        to: { name: body.name, parentId: parent },
      });
    });
    return this.groups(organizationId);
  }

  /** Deletes an empty group (no member, no sub-group); pending invitations lose it. */
  async deleteGroup(actor: Actor, organizationId: string, groupId: string): Promise<OrgGroup[]> {
    const context = await this.orgs.manager(actor.userId, organizationId);
    this.orgs.requireBusiness(context);
    await this.checkGroup(context, groupId);
    await this.prisma.client.$transaction(async (tx) => {
      const [members, children] = await Promise.all([
        tx.membership.count({ where: { groupId } }),
        tx.orgGroup.count({ where: { parentId: groupId } }),
      ]);
      if (members || children) fail(HttpStatus.CONFLICT, 'group_not_empty');
      // Served by a secretariat, or the class of a print request (kept with its journal).
      const [served, requests, invited] = await Promise.all([
        tx.secretariatScope.count({ where: { groupId } }),
        tx.printRequest.count({ where: { groupId } }),
        tx.invitation.count({
          where: { organizationId, status: 'PENDING', scopeGroupIds: { has: groupId } },
        }),
      ]);
      if (served || requests || invited) fail(HttpStatus.CONFLICT, 'group_in_use');
      await tx.invitation.updateMany({ where: { groupId }, data: { groupId: null } });
      const group = await tx.orgGroup.delete({ where: { id: groupId } });
      await this.orgs.audit(tx, actor, 'ORG_GROUP_DELETED', 'OrgGroup', groupId, {
        organizationId,
        name: group.name,
      });
    });
    return this.groups(organizationId);
  }
}
