import type {
  AuditLog,
  Comment,
  CommentReply,
  Compilation,
  FileDocument,
  Notification,
  Plan,
  Project,
  ProjectFile,
  ProjectFolder,
  ProjectInvitation,
  ProjectMember,
  ProjectRole,
  ProjectVersion,
  ShareLink,
  ShareLinkOpening,
  Submission,
  SubmissionReviewer,
  SubmissionVersion,
  SubscriptionStatus,
  UsageCounter,
  User,
  ValidationRecord,
} from '@integris/db';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

type Where = Record<string, unknown>;

interface SubscriptionDates {
  status: SubscriptionStatus;
  currentPeriodEnd: Date;
  graceEndsAt: Date | null;
}

const DAY_MS = 86_400_000;

const MIB = 1024n * 1024n;

const defaultPlans = () => [
  testPlan('FREE', { maxProjects: 3, storageBytes: 100n * MIB }),
  testPlan('STANDARD', { maxProjects: null, storageBytes: 2048n * MIB }),
];

function testPlan(code: 'FREE' | 'STANDARD', quotas: Partial<Plan>): Plan {
  return {
    id: code,
    code,
    nameFr: code,
    nameEn: code,
    priceMonthlyXof: 0,
    priceYearlyXof: 0,
    minSeats: 1,
    maxSeats: 1,
    volumeDiscountFromSeats: null,
    volumeDiscountPercent: null,
    maxProjects: null,
    maxCollaboratorsPerProject: null,
    maxCompileSeconds: 20,
    maxCompilesPerHour: 30,
    storageBytes: 0n,
    historyDays: null,
    autoCompile: false,
    supervisionDashboard: false,
    maxSupervisedStudents: null,
    aiRequestsPerDay: 0,
    compilePriority: 'LOW',
    maxAdmins: 0,
    trialDays: null,
    isActive: true,
    updatedAt: new Date(),
    ...quotas,
  };
}

/**
 * In-memory stand-in for the Prisma calls made by the projects module (the call shapes used by
 * ProjectsService, FilesService, QuotaService and TemplatesService), so tests never write to the
 * shared development database.
 */
export class FakeProjectsDb {
  users: User[] = [];
  /** Plans as the `Plan` table holds them (test values, editable per test). */
  plans: Plan[] = defaultPlans();
  /** Plan codes of the live personal subscriptions, per user. */
  personalPlans = new Map<string, string>();
  /** Dates of a personal subscription (default: active, period ending in 30 days). */
  subscriptionDates = new Map<string, SubscriptionDates>();
  /** Seats held in a TEAM or BUSINESS, per user. */
  seatPlans = new Map<string, { code: string; organizationName: string }[]>();
  usageCounters: UsageCounter[] = [];
  notifications: Notification[] = [];
  projects: Project[] = [];
  files: ProjectFile[] = [];
  folders: ProjectFolder[] = [];
  members: ProjectMember[] = [];
  /** Validated submissions (project id, submission id) and the submissions with a trace. */
  validated: { projectId: string; id: string }[] = [];
  traced = new Set<string>();
  compilations: Compilation[] = [];
  versions: ProjectVersion[] = [];
  documents = new Map<string, FileDocument>();
  audits: Partial<AuditLog>[] = [];
  invitations: ProjectInvitation[] = [];
  links: ShareLink[] = [];
  comments: Comment[] = [];
  replies: CommentReply[] = [];
  openings: ShareLinkOpening[] = [];
  submissions: Submission[] = [];
  reviewers: SubmissionReviewer[] = [];
  submissionVersions: SubmissionVersion[] = [];
  records: ValidationRecord[] = [];
  /** Makes the next audit entry fail (tests of the transactions). */
  failNextAudit = false;

  private snapshot() {
    const copy = <T extends object>(rows: T[]) => rows.map((row) => ({ ...row }));
    return {
      members: copy(this.members),
      invitations: copy(this.invitations),
      links: copy(this.links),
      openings: copy(this.openings),
      audits: copy(this.audits),
      submissions: copy(this.submissions),
      reviewers: copy(this.reviewers),
      submissionVersions: copy(this.submissionVersions),
      records: copy(this.records),
      files: copy(this.files),
      folders: copy(this.folders),
      projects: copy(this.projects),
    };
  }

  private restore(saved: ReturnType<FakeProjectsDb['snapshot']>) {
    Object.assign(this, saved);
  }

  reset(): void {
    this.plans = defaultPlans();
    this.users = [];
    this.personalPlans.clear();
    this.subscriptionDates.clear();
    this.seatPlans.clear();
    this.usageCounters = [];
    this.notifications = [];
    this.projects = [];
    this.files = [];
    this.folders = [];
    this.members = [];
    this.validated = [];
    this.traced.clear();
    this.compilations = [];
    this.versions = [];
    this.documents.clear();
    this.audits = [];
    this.invitations = [];
    this.links = [];
    this.comments = [];
    this.replies = [];
    this.openings = [];
    this.submissions = [];
    this.reviewers = [];
    this.submissionVersions = [];
    this.records = [];
    this.failNextAudit = false;
  }

  addUser(displayName: string): User {
    const user: User = {
      id: randomUUID(),
      phone: null,
      phoneVerifiedAt: null,
      email: null,
      emailVerifiedAt: null,
      passwordHash: null,
      displayName,
      locale: 'fr',
      editorSpellcheck: false,
      lastSpace: null,
      isSuperAdmin: false,
      disabledAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.users.push(user);
    return user;
  }

  share(projectId: string, userId: string, role: ProjectRole): void {
    this.members.push({ id: randomUUID(), projectId, userId, role, createdAt: new Date() });
  }

  private person(id: string | null) {
    if (!id) return null;
    const user = this.users.find((item) => item.id === id)!;
    return { id: user.id, displayName: user.displayName };
  }

  private submissionOf(id: string): Submission | undefined {
    return this.submissions.find((item) => item.id === id);
  }

  /** A submission with what SubmissionsService includes (author, reviewers, versions). */
  private submissionView(row: Submission) {
    return {
      ...row,
      author: this.person(row.authorId)!,
      reviewers: this.reviewers
        .filter((item) => item.submissionId === row.id)
        .map((item) => ({ ...item, reviewer: this.person(item.reviewerId)! })),
      versions: this.submissionVersions
        .filter((item) => item.submissionId === row.id)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((item) => ({
          ...item,
          sentBy: this.person(item.sentById)!,
          compilation: this.compilations.find((c) => c.submissionVersionId === item.id) ?? null,
        })),
    };
  }

  /** A comment with what CommentsService includes (authors, replies). */
  private commentView(row: Comment) {
    return {
      ...row,
      author: this.person(row.authorId),
      resolvedBy: this.person(row.resolvedById),
      suggestionDecidedBy: this.person(row.suggestionDecidedById),
      replies: this.replies
        .filter((reply) => reply.commentId === row.id)
        .map((reply) => ({ ...reply, author: this.person(reply.authorId) })),
    };
  }

  /** The `where` clauses used by the sharing service on invitations. */
  private matchesInvitation(row: ProjectInvitation, where: Where): boolean {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.projectId !== undefined && row.projectId !== where.projectId) return false;
    if (where.status !== undefined && row.status !== where.status) return false;
    const expires = where.expiresAt as { lte?: Date; gt?: Date } | undefined;
    if (expires?.lte && !(row.expiresAt <= expires.lte)) return false;
    if (expires?.gt && !(row.expiresAt > expires.gt)) return false;
    return true;
  }

  private matchesLink(row: ShareLink, where: Where): boolean {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.projectId !== undefined && row.projectId !== where.projectId) return false;
    if (where.revokedAt === null && row.revokedAt !== null) return false;
    if (Array.isArray(where.OR) && row.expiresAt && row.expiresAt <= new Date()) return false;
    return true;
  }

  private project(id: string): Project {
    const project = this.projects.find((item) => item.id === id);
    if (!project) throw new Error('Not found');
    return project;
  }

  private matchesProject(project: Project, where: Where): boolean {
    if (where.id !== undefined && project.id !== where.id) return false;
    if (where.ownerId !== undefined && project.ownerId !== where.ownerId) return false;
    if (where.deletedAt === null && project.deletedAt !== null) return false;
    const deleted = where.deletedAt as { not?: null; lt?: Date } | undefined;
    if (deleted?.not === null && project.deletedAt === null) return false;
    if (deleted?.lt && !(project.deletedAt && project.deletedAt < deleted.lt)) return false;
    if (Array.isArray(where.OR)) {
      return (where.OR as Where[]).some((clause) => {
        if (clause.ownerId !== undefined) return project.ownerId === clause.ownerId;
        const userId = (clause.members as { some: { userId: string } }).some.userId;
        return this.members.some((m) => m.projectId === project.id && m.userId === userId);
      });
    }
    return true;
  }

  private withMembers(project: Project, include?: Where) {
    if (!include) return project;
    const userId = (include.members as { where: { userId: string } }).where.userId;
    return {
      ...project,
      members: this.members
        .filter((m) => m.projectId === project.id && m.userId === userId)
        .map((m) => ({ role: m.role })),
      ...(include.owner
        ? { owner: { displayName: this.users.find((u) => u.id === project.ownerId)!.displayName } }
        : {}),
    };
  }

  private matchesFile(file: ProjectFile, where: Where): boolean {
    if (where.id !== undefined) {
      const id = where.id as string | { in: string[] };
      if (typeof id === 'string' ? file.id !== id : !id.in.includes(file.id)) return false;
    }
    if (where.projectId !== undefined) {
      const projectId = where.projectId as string | { in: string[] };
      const ok =
        typeof projectId === 'string'
          ? file.projectId === projectId
          : projectId.in.includes(file.projectId);
      if (!ok) return false;
    }
    if (where.project) {
      const { ownerId } = where.project as { ownerId: string };
      if (this.project(file.projectId).ownerId !== ownerId) return false;
    }
    if (where.path !== undefined) {
      const path = where.path as string | { in: string[] };
      if (typeof path === 'string' ? file.path !== path : !path.in.includes(file.path)) {
        return false;
      }
    }
    if (
      where.lockedBySubmissionId !== undefined &&
      file.lockedBySubmissionId !== where.lockedBySubmissionId
    ) {
      return false;
    }
    return true;
  }

  /** The `where` clauses used by the compile service. */
  private matchesCompilation(row: Compilation, where: Where): boolean {
    if (where.id !== undefined) {
      const id = where.id as string | { in: string[] };
      if (typeof id === 'string' ? row.id !== id : !id.in.includes(row.id)) return false;
    }
    if (where.submissionVersionId === null && row.submissionVersionId !== null) return false;
    if (where.projectId !== undefined && row.projectId !== where.projectId) return false;
    const status = where.status as string | { in?: string[]; not?: string } | undefined;
    if (typeof status === 'string' && row.status !== status) return false;
    if (status && typeof status === 'object') {
      if (status.in && !status.in.includes(row.status)) return false;
      if (status.not && row.status === status.not) return false;
    }
    if (where.pdfKey && row.pdfKey === null) return false;
    if (Array.isArray(where.OR) && !(row.pdfKey || row.logKey)) return false;
    return true;
  }

  /** The `where` clauses used by the history service. */
  private matchesVersion(row: ProjectVersion, where: Where): boolean {
    if (where.id !== undefined) {
      const id = where.id as string | { in: string[] };
      if (typeof id === 'string' ? row.id !== id : !id.in.includes(row.id)) return false;
    }
    if (where.projectId !== undefined && row.projectId !== where.projectId) return false;
    const kind = where.kind as string | { not: string } | undefined;
    if (typeof kind === 'string' && row.kind !== kind) return false;
    if (kind && typeof kind === 'object' && row.kind === kind.not) return false;
    const created = where.createdAt as { gte?: Date; lt?: Date } | undefined;
    if (created?.gte && row.createdAt < created.gte) return false;
    if (created?.lt && !(row.createdAt < created.lt)) return false;
    if (Array.isArray(where.OR)) {
      return (where.OR as Where[]).some((clause) => this.matchesVersion(row, clause));
    }
    return true;
  }

  private versionsWhere(where: Where): ProjectVersion[] {
    return this.versions
      .filter((row) => this.matchesVersion(row, where))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  private compilationsWhere(where: Where): Compilation[] {
    return this.compilations
      .filter((row) => this.matchesCompilation(row, where))
      .sort((a, b) => b.queuedAt.getTime() - a.queuedAt.getTime());
  }

  private counterOf(key: { userId: string; periodStart: Date }): UsageCounter | undefined {
    return this.usageCounters.find(
      (row) => row.userId === key.userId && row.periodStart.getTime() === key.periodStart.getTime(),
    );
  }

  private planByCode(code: string): Plan {
    return this.plans.find((plan) => plan.code === code)!;
  }

  readonly client = {
    // Batches and interactive transactions; a failed interactive one undoes its rows (tests of
    // "no change without its audit entry" rely on it).
    $transaction: async (operations: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) => {
      if (Array.isArray(operations)) return Promise.all(operations);
      const saved = this.snapshot();
      try {
        return await operations(this.client);
      } catch (error) {
        this.restore(saved);
        throw error;
      }
    },
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        this.users.find((item) => item.id === where.id) ?? null,
      findFirst: async ({ where }: { where: { phone?: string; email?: string } }) =>
        this.users.find((item) =>
          where.phone !== undefined ? item.phone === where.phone : item.email === where.email,
        ) ?? null,
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        this.users.filter((item) => where.id.in.includes(item.id)),
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const user = this.users.find((item) => item.id === where.id);
        if (!user) throw new Error('Not found');
        return user;
      },
    },
    plan: {
      findUniqueOrThrow: async ({ where }: { where: { code: string } }) =>
        this.planByCode(where.code),
    },
    subscription: {
      findMany: async ({ where }: { where: { userId: string } }) => {
        const code = this.personalPlans.get(where.userId);
        const dates = this.subscriptionDates.get(where.userId) ?? {
          status: 'ACTIVE',
          currentPeriodEnd: new Date(Date.now() + 30 * DAY_MS),
          graceEndsAt: null,
        };
        return code ? [{ plan: this.planByCode(code), ...dates }] : [];
      },
    },
    seat: {
      findMany: async ({ where }: { where: { userId: string } }) =>
        (this.seatPlans.get(where.userId) ?? []).map((seat) => ({
          subscription: {
            plan: this.planByCode(seat.code),
            organization: { name: seat.organizationName },
            status: 'ACTIVE',
            currentPeriodEnd: new Date(Date.now() + 30 * DAY_MS),
            graceEndsAt: null,
          },
        })),
    },
    usageCounter: {
      findUnique: async ({
        where,
      }: {
        where: { userId_periodStart: { userId: string; periodStart: Date } };
      }) => this.counterOf(where.userId_periodStart) ?? null,
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { userId_periodStart: { userId: string; periodStart: Date } };
        create: Partial<UsageCounter>;
        update: Record<string, unknown>;
      }) => {
        let row = this.counterOf(where.userId_periodStart);
        if (!row) {
          row = {
            id: randomUUID(),
            ...where.userId_periodStart,
            compileCount: 0,
            compileSeconds: 0,
            storageBytes: 0n,
            aiRequests: 0,
            updatedAt: new Date(),
            ...create,
          } as UsageCounter;
          this.usageCounters.push(row);
          return { ...row };
        }
        for (const [key, value] of Object.entries(update)) {
          const field = key as 'compileCount' | 'compileSeconds';
          if (value && typeof value === 'object' && 'increment' in value) {
            row[field] += (value as { increment: number }).increment;
          } else {
            Object.assign(row, { [key]: value });
          }
        }
        return { ...row };
      },
    },
    notification: {
      createMany: async ({
        data,
        skipDuplicates,
      }: {
        data: (Partial<Notification> & { userId: string; type: string })[];
        skipDuplicates?: boolean;
      }) => {
        let count = 0;
        for (const row of data) {
          const exists =
            row.dedupeKey && this.notifications.some((n) => n.dedupeKey === row.dedupeKey);
          if (exists && skipDuplicates) continue;
          if (exists) throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
          this.notifications.push({
            id: randomUUID(),
            channel: 'IN_APP',
            payload: {},
            dedupeKey: null,
            sentAt: null,
            readAt: null,
            createdAt: new Date(),
            ...row,
          } as Notification);
          count++;
        }
        return { count };
      },
    },
    printRequest: { count: async () => 0 },
    template: { findMany: async () => [], findFirst: async () => null },
    commentReply: {
      create: async ({ data }: { data: Pick<CommentReply, 'commentId' | 'authorId' | 'body'> }) => {
        const row: CommentReply = { id: randomUUID(), createdAt: new Date(), ...data };
        this.replies.push(row);
        return row;
      },
      deleteMany: async ({ where }: { where: { comment: { projectId: string } } }) => {
        const ids = new Set(
          this.comments.filter((c) => c.projectId === where.comment.projectId).map((c) => c.id),
        );
        this.replies = this.replies.filter((reply) => !ids.has(reply.commentId));
        return { count: 0 };
      },
    },
    comment: {
      create: async ({ data }: { data: Partial<Comment> }) => {
        const row: Comment = {
          id: randomUUID(),
          projectId: data.projectId!,
          fileId: data.fileId ?? null,
          authorId: data.authorId!,
          anchor: data.anchor!,
          quotedText: data.quotedText!,
          body: data.body!,
          suggestedText: data.suggestedText ?? null,
          suggestionStatus: data.suggestionStatus ?? null,
          suggestionDecidedById: null,
          suggestionDecidedAt: null,
          status: 'OPEN',
          submissionId: null,
          createdAt: new Date(Date.now() + this.comments.length),
          resolvedAt: null,
          resolvedById: null,
        };
        this.comments.push(row);
        return { ...row };
      },
      findMany: async ({ where }: { where: { projectId: string } }) =>
        this.comments
          .filter((row) => row.projectId === where.projectId)
          .map((row) => this.commentView(row)),
      findFirst: async ({ where }: { where: { id: string; projectId: string } }) => {
        const row = this.comments.find(
          (item) => item.id === where.id && item.projectId === where.projectId,
        );
        return row ? this.commentView(row) : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Comment> }) => {
        const row = this.comments.find((item) => item.id === where.id)!;
        Object.assign(row, data);
        return { ...row };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; suggestionStatus: string };
        data: Partial<Comment>;
      }) => {
        const rows = this.comments.filter(
          (row) => row.id === where.id && row.suggestionStatus === where.suggestionStatus,
        );
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
      deleteMany: async ({ where }: { where: { projectId: string } }) => {
        this.comments = this.comments.filter((row) => row.projectId !== where.projectId);
        return { count: 0 };
      },
    },
    projectInvitation: {
      create: async ({ data }: { data: Partial<ProjectInvitation> }) => {
        const clash = this.invitations.some(
          (row) =>
            row.projectId === data.projectId &&
            row.status === 'PENDING' &&
            ((data.phone && row.phone === data.phone) || (data.email && row.email === data.email)),
        );
        if (clash) throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
        const row: ProjectInvitation = {
          id: randomUUID(),
          projectId: data.projectId!,
          invitedById: data.invitedById!,
          phone: data.phone ?? null,
          email: data.email ?? null,
          role: data.role!,
          message: data.message ?? null,
          locale: data.locale ?? 'fr',
          tokenHash: data.tokenHash!,
          status: 'PENDING',
          expiresAt: data.expiresAt!,
          acceptedById: null,
          decidedAt: null,
          createdAt: new Date(Date.now() + this.invitations.length),
        };
        this.invitations.push(row);
        return { ...row };
      },
      findMany: async ({ where }: { where: Where }) =>
        this.invitations
          .filter((row) => this.matchesInvitation(row, where))
          .map((row) => ({ ...row })),
      findUnique: async ({ where }: { where: { tokenHash: string } }) => {
        const row = this.invitations.find((item) => item.tokenHash === where.tokenHash);
        if (!row) return null;
        const project = this.projects.find((item) => item.id === row.projectId)!;
        return {
          ...row,
          project: { name: project.name, deletedAt: project.deletedAt, ownerId: project.ownerId },
          invitedBy: { displayName: this.person(row.invitedById)!.displayName },
        };
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<ProjectInvitation>;
      }) => {
        const row = this.invitations.find((item) => item.id === where.id)!;
        Object.assign(row, data);
        return { ...row };
      },
      updateMany: async ({ where, data }: { where: Where; data: Partial<ProjectInvitation> }) => {
        const rows = this.invitations.filter((row) => this.matchesInvitation(row, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
      deleteMany: async ({ where }: { where: { projectId: string } }) => {
        this.invitations = this.invitations.filter((row) => row.projectId !== where.projectId);
        return { count: 0 };
      },
    },
    submissionReviewer: {
      findMany: async ({ where }: { where: { submissionId: string } }) =>
        this.reviewers.filter((row) => row.submissionId === where.submissionId),
      createMany: async ({ data }: { data: { submissionId: string; reviewerId: string }[] }) => {
        for (const row of data)
          this.reviewers.push({ id: randomUUID(), lastReviewedAt: null, ...row });
        return { count: data.length };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { submissionId: string; reviewerId: string };
        data: Partial<SubmissionReviewer>;
      }) => {
        const rows = this.reviewers.filter(
          (row) => row.submissionId === where.submissionId && row.reviewerId === where.reviewerId,
        );
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
      deleteMany: async ({ where }: { where: Where }) => {
        const notIn = (where.reviewerId as { notIn?: string[] } | undefined)?.notIn;
        const projectId = (where.submission as { projectId?: string } | undefined)?.projectId;
        this.reviewers = this.reviewers.filter((row) => {
          if (projectId !== undefined)
            return this.submissionOf(row.submissionId)?.projectId !== projectId;
          if (row.submissionId !== where.submissionId) return true;
          return notIn ? notIn.includes(row.reviewerId) : false;
        });
        return { count: 0 };
      },
    },
    submission: {
      findFirst: async ({ where }: { where: { id: string; projectId: string } }) => {
        const row = this.submissions.find(
          (item) => item.id === where.id && item.projectId === where.projectId,
        );
        return row ? this.submissionView(row) : null;
      },
      findMany: async ({ where, include }: { where: Where; include?: Where }) => {
        // Moving files: the submissions that can still be sent follow the new paths.
        const not = (where.status as { not?: string } | undefined)?.not;
        if (not) {
          return this.submissions
            .filter((item) => item.projectId === where.projectId && item.status !== not)
            .map((item) => ({ id: item.id, filePaths: [...item.filePaths] }));
        }
        // Erasing a project: its validated submissions (test rows of `validated` included).
        if (!include) {
          return [
            ...this.validated.filter((item) => item.projectId === where.projectId),
            ...this.submissions
              .filter((item) => item.projectId === where.projectId && item.status === where.status)
              .map((item) => ({ id: item.id })),
          ];
        }
        let rows = this.submissions;
        if (where.projectId !== undefined) {
          rows = rows.filter((item) => item.projectId === where.projectId);
        }
        if (where.reviewers) {
          // Submissions to review: SubmissionsService.toReview.
          const userId = (where.reviewers as { some: { reviewerId: string } }).some.reviewerId;
          const statuses = (where.status as { in: string[] }).in;
          const roles = ['SUPERVISOR', 'REVIEWER'];
          rows = rows.filter(
            (item) =>
              statuses.includes(item.status) &&
              this.reviewers.some((r) => r.submissionId === item.id && r.reviewerId === userId) &&
              this.project(item.projectId).deletedAt === null &&
              this.members.some(
                (m) =>
                  m.projectId === item.projectId && m.userId === userId && roles.includes(m.role),
              ),
          );
        }
        return rows
          .slice()
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
          .map((row) => ({
            ...this.submissionView(row),
            project: { name: this.project(row.projectId).name },
          }));
      },
      create: async ({
        data,
      }: {
        data: Partial<Submission> & {
          projectId: string;
          authorId: string;
          reviewers: { create: { reviewerId: string }[] };
        };
      }) => {
        const { reviewers, ...fields } = data;
        const now = new Date();
        const row: Submission = {
          id: randomUUID(),
          title: null,
          filePaths: [],
          message: null,
          dueAt: null,
          status: 'DRAFT',
          submittedAt: null,
          validatedAt: null,
          validatedById: null,
          validatedNumber: null,
          unlockedAt: null,
          unlockedById: null,
          createdAt: now,
          updatedAt: now,
          ...fields,
        };
        this.submissions.push(row);
        for (const reviewer of reviewers.create) {
          this.reviewers.push({
            id: randomUUID(),
            submissionId: row.id,
            reviewerId: reviewer.reviewerId,
            lastReviewedAt: null,
          });
        }
        return { ...row };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Submission> }) => {
        const row = this.submissionOf(where.id)!;
        Object.assign(row, data, { updatedAt: new Date() });
        return { ...row };
      },
      updateMany: async ({ where, data }: { where: Where; data: Partial<Submission> }) => {
        const rows = this.submissions.filter((row) => {
          if (row.id !== where.id) return false;
          const status = where.status as string | { in?: string[]; notIn?: string[] } | undefined;
          if (typeof status === 'string' && row.status !== status) return false;
          if (status && typeof status === 'object') {
            if (status.in && !status.in.includes(row.status)) return false;
            if (status.notIn?.includes(row.status)) return false;
          }
          if (where.unlockedAt === null && row.unlockedAt !== null) return false;
          return true;
        });
        for (const row of rows) Object.assign(row, data, { updatedAt: new Date() });
        return { count: rows.length };
      },
      deleteMany: async ({ where }: { where: Where }) => {
        if (where.id === undefined) {
          this.validated = this.validated.filter((item) => item.projectId !== where.projectId);
        }
        this.submissions = this.submissions.filter((item) =>
          where.id !== undefined
            ? !(item.id === where.id && item.status === where.status)
            : item.projectId !== where.projectId,
        );
        return { count: 0 };
      },
    },
    submissionVersion: {
      create: async ({ data }: { data: Partial<SubmissionVersion> }) => {
        const busy = this.submissionVersions.some(
          (row) => row.submissionId === data.submissionId && row.state === 'COMPILING',
        );
        if (busy) throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
        const row: SubmissionVersion = {
          id: randomUUID(),
          submissionId: data.submissionId!,
          number: null,
          projectVersionId: data.projectVersionId!,
          filePaths: data.filePaths ?? [],
          message: data.message ?? null,
          files: data.files ?? [],
          sentById: data.sentById!,
          sentIp: data.sentIp ?? null,
          state: 'COMPILING',
          // Strictly increasing, so "latest first" is well defined in tests.
          createdAt: new Date(Date.now() + this.submissionVersions.length),
          readyAt: null,
        };
        this.submissionVersions.push(row);
        return { ...row };
      },
      findUnique: async ({ where, include }: { where: { id: string }; include?: Where }) => {
        const row = this.submissionVersions.find((item) => item.id === where.id);
        if (!row) return null;
        return {
          ...row,
          ...(include?.projectVersion
            ? { projectVersion: this.versions.find((v) => v.id === row.projectVersionId) }
            : {}),
          ...(include?.submission
            ? { submission: { ...this.submissionOf(row.submissionId)! } }
            : {}),
        };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; state: string };
        data: Partial<SubmissionVersion>;
      }) => {
        const rows = this.submissionVersions.filter(
          (row) => row.id === where.id && row.state === where.state,
        );
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
      count: async ({ where }: { where: { submissionId: string; state: string } }) =>
        this.submissionVersions.filter(
          (row) => row.submissionId === where.submissionId && row.state === where.state,
        ).length,
      deleteMany: async ({ where }: { where: Where }) => {
        const ids = (where.id as { in: string[] } | undefined)?.in;
        const projectId = (where.submission as { projectId?: string } | undefined)?.projectId;
        this.submissionVersions = this.submissionVersions.filter((row) =>
          ids
            ? !ids.includes(row.id)
            : this.submissionOf(row.submissionId)?.projectId !== projectId,
        );
        return { count: 0 };
      },
    },
    validationRecord: {
      count: async ({ where }: { where: { submissionId: { in: string[] } } }) =>
        where.submissionId.in.filter(
          (id) => this.traced.has(id) || this.records.some((row) => row.submissionId === id),
        ).length,
      create: async ({ data }: { data: Omit<ValidationRecord, 'id' | 'createdAt'> }) => {
        if (this.records.some((row) => row.submissionId === data.submissionId)) {
          throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
        }
        const row: ValidationRecord = { id: randomUUID(), createdAt: new Date(), ...data };
        this.records.push(row);
        return { ...row };
      },
    },
    projectVersion: {
      create: async ({ data }: { data: Partial<ProjectVersion> }) => {
        const row: ProjectVersion = {
          id: randomUUID(),
          projectId: data.projectId!,
          kind: data.kind!,
          label: data.label ?? null,
          storageKey: data.storageKey!,
          fileCount: data.fileCount ?? 0,
          restoreOfId: data.restoreOfId ?? null,
          restorePath: data.restorePath ?? null,
          createdById: data.createdById ?? null,
          // Strictly increasing, so "latest first" is well defined in tests.
          createdAt: new Date(Date.now() + this.versions.length),
        };
        this.versions.push(row);
        return { ...row };
      },
      findFirst: async ({ where }: { where: Where }) => {
        const row = this.versionsWhere(where)[0];
        return row ? { ...row } : null;
      },
      findMany: async ({ where, take }: { where: Where; take?: number }) =>
        this.versionsWhere(where)
          .slice(0, take)
          .map((row) => ({ ...row })),
      count: async ({ where }: { where: Where }) => this.versionsWhere(where).length,
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const row = this.versions.find((item) => item.id === where.id);
        if (!row) throw new Error('Not found');
        return { ...row };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<ProjectVersion> }) => {
        const row = this.versions.find((item) => item.id === where.id)!;
        Object.assign(row, data);
        return { ...row };
      },
      deleteMany: async ({ where }: { where: { projectId: string } }) => {
        this.versions = this.versions.filter((row) => row.projectId !== where.projectId);
        return { count: 0 };
      },
    },
    fileDocument: {
      findUnique: async ({ where }: { where: { fileId: string } }) => {
        const row = this.documents.get(where.fileId);
        return row ? { ...row } : null;
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { fileId: string };
        create: Omit<FileDocument, 'updatedAt'>;
        update: Partial<FileDocument>;
      }) => {
        const row = this.documents.get(where.fileId);
        const next = { ...(row ?? create), ...(row ? update : {}), updatedAt: new Date() };
        this.documents.set(where.fileId, next as FileDocument);
        return next;
      },
    },
    auditLog: {
      findMany: async ({ where }: { where: { targetType: string; targetId: string } }) =>
        this.audits
          .filter((row) => row.targetType === where.targetType && row.targetId === where.targetId)
          .map((row) => ({
            createdAt: new Date(),
            metadata: null,
            ...row,
            actor: this.person(row.actorId ?? null),
          })),
      create: async ({ data }: { data: Partial<AuditLog> }) => {
        if (this.failNextAudit) {
          this.failNextAudit = false;
          throw new Error('Audit write failed');
        }
        this.audits.push(data);
        return data;
      },
    },
    compilation: {
      create: async ({ data }: { data: Partial<Compilation> }) => {
        const row: Compilation = {
          id: data.id ?? randomUUID(),
          projectId: data.projectId!,
          triggeredById: data.triggeredById!,
          chargedUserId: data.chargedUserId!,
          engine: data.engine ?? 'PDFLATEX',
          status: data.status ?? 'QUEUED',
          priority: data.priority ?? 'LOW',
          // Strictly increasing, so "latest first" is well defined in tests.
          queuedAt: new Date(Date.now() + this.compilations.length),
          startedAt: null,
          finishedAt: null,
          durationMs: null,
          pdfKey: null,
          logKey: null,
          errors: null,
          workerHost: null,
          submissionVersionId: data.submissionVersionId ?? null,
        };
        this.compilations.push(row);
        return { ...row };
      },
      findUnique: async ({ where }: { where: { id?: string; submissionVersionId?: string } }) => {
        const row = this.compilations.find((item) =>
          where.id !== undefined
            ? item.id === where.id
            : item.submissionVersionId === where.submissionVersionId,
        );
        return row ? { ...row } : null;
      },
      findFirst: async ({ where }: { where: Where }) => {
        const row = this.compilationsWhere(where)[0];
        return row ? { ...row } : null;
      },
      findMany: async ({ where }: { where: Where }) =>
        this.compilationsWhere(where).map((row) => ({ ...row })),
      update: async ({ where, data }: { where: { id: string }; data: Partial<Compilation> }) => {
        const row = this.compilations.find((item) => item.id === where.id)!;
        Object.assign(row, data);
        return { ...row };
      },
      updateMany: async ({ where, data }: { where: Where; data: Partial<Compilation> }) => {
        const rows = this.compilations.filter((row) => this.matchesCompilation(row, where));
        for (const row of rows) {
          for (const [key, value] of Object.entries(data)) {
            if (value !== undefined) Object.assign(row, { [key]: value });
          }
        }
        return { count: rows.length };
      },
      deleteMany: async ({ where }: { where: Where }) => {
        this.compilations = this.compilations.filter((row) => !this.matchesCompilation(row, where));
        return { count: 0 };
      },
    },
    shareLinkOpening: {
      createMany: async ({
        data,
      }: {
        data: Pick<ShareLinkOpening, 'linkId' | 'ip' | 'hour'>[];
      }) => {
        let count = 0;
        for (const row of data) {
          const exists = this.openings.some(
            (item) =>
              item.linkId === row.linkId &&
              item.ip === row.ip &&
              item.hour.getTime() === row.hour.getTime(),
          );
          if (exists) continue;
          this.openings.push({
            id: randomUUID(),
            count: 1,
            firstAt: new Date(),
            lastAt: new Date(),
            ...row,
          });
          count++;
        }
        return { count };
      },
      update: async ({
        where,
      }: {
        where: { linkId_ip_hour: Pick<ShareLinkOpening, 'linkId' | 'ip' | 'hour'> };
      }) => {
        const key = where.linkId_ip_hour;
        const row = this.openings.find(
          (item) =>
            item.linkId === key.linkId &&
            item.ip === key.ip &&
            item.hour.getTime() === key.hour.getTime(),
        )!;
        row.count++;
        row.lastAt = new Date();
        return { ...row };
      },
      deleteMany: async ({ where }: { where: { link: { projectId: string } } }) => {
        const ids = new Set(
          this.links.filter((link) => link.projectId === where.link.projectId).map((l) => l.id),
        );
        this.openings = this.openings.filter((row) => !ids.has(row.linkId));
        return { count: 0 };
      },
    },
    shareLink: {
      create: async ({ data }: { data: Partial<ShareLink> }) => {
        const row: ShareLink = {
          id: data.id ?? randomUUID(),
          projectId: data.projectId!,
          tokenHash: data.tokenHash!,
          includeSources: data.includeSources ?? false,
          createdById: data.createdById ?? null,
          expiresAt: data.expiresAt ?? null,
          revokedAt: null,
          createdAt: new Date(),
        };
        this.links.push(row);
        return { ...row };
      },
      findFirst: async ({ where }: { where: Where }) => {
        const row = this.links.filter((item) => this.matchesLink(item, where)).at(-1);
        return row ? { ...row } : null;
      },
      findUnique: async ({ where }: { where: { tokenHash: string } }) => {
        const row = this.links.find((item) => item.tokenHash === where.tokenHash);
        return row ? { ...row, project: this.project(row.projectId) } : null;
      },
      updateMany: async ({ where, data }: { where: Where; data: Partial<ShareLink> }) => {
        const rows = this.links.filter((row) => this.matchesLink(row, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
      deleteMany: async ({ where }: { where: { projectId: string } }) => {
        this.links = this.links.filter((row) => row.projectId !== where.projectId);
        return { count: 0 };
      },
    },
    projectMember: {
      findMany: async ({ where }: { where: Where }) =>
        this.members
          .filter(
            (m) =>
              m.projectId === where.projectId &&
              (!where.userId || (where.userId as { in: string[] }).in.includes(m.userId)) &&
              (!where.role || (where.role as { in: string[] }).in.includes(m.role)),
          )
          .map((m) => ({ ...m, user: this.person(m.userId)! })),
      findUnique: async ({
        where,
      }: {
        where: { projectId_userId: { projectId: string; userId: string } };
      }) => {
        const row = this.members.find(
          (m) =>
            m.projectId === where.projectId_userId.projectId &&
            m.userId === where.projectId_userId.userId,
        );
        return row ? { ...row } : null;
      },
      create: async ({ data }: { data: Pick<ProjectMember, 'projectId' | 'userId' | 'role'> }) => {
        const row: ProjectMember = { id: randomUUID(), createdAt: new Date(), ...data };
        this.members.push(row);
        return { ...row };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<ProjectMember> }) => {
        const row = this.members.find((m) => m.id === where.id)!;
        Object.assign(row, data);
        return { ...row };
      },
      delete: async ({ where }: { where: { id: string } }) => {
        this.members = this.members.filter((m) => m.id !== where.id);
      },
      deleteMany: async ({ where }: { where: { projectId: string } }) => {
        this.members = this.members.filter((m) => m.projectId !== where.projectId);
        return { count: 0 };
      },
    },
    project: {
      findUnique: async ({ where, include }: { where: { id: string }; include?: Where }) => {
        const project = this.projects.find((item) => item.id === where.id);
        return project ? this.withMembers(project, include) : null;
      },
      findMany: async ({
        where,
        include,
        orderBy,
      }: {
        where: Where;
        include?: Where;
        orderBy?: Where | Where[];
      }) => {
        const rows = this.projects.filter((project) => this.matchesProject(project, where));
        const first = Array.isArray(orderBy) ? orderBy[0] : orderBy;
        // Most recently active first; the creation order breaks ties (newest first).
        if (first?.lastActivityAt === 'desc') {
          rows.sort(
            (a, b) =>
              b.lastActivityAt.getTime() - a.lastActivityAt.getTime() ||
              this.projects.indexOf(b) - this.projects.indexOf(a),
          );
        }
        return rows.map((project) => this.withMembers(project, include));
      },
      count: async ({ where }: { where: Where }) =>
        this.projects.filter((project) => this.matchesProject(project, where)).length,
      updateMany: async ({ where, data }: { where: Where; data: Partial<Project> }) => {
        const ids = (where.id as { in?: string[] } | string | undefined) ?? undefined;
        const rows = this.projects.filter(
          (project) =>
            (typeof ids === 'string' ? project.id === ids : (ids?.in ?? []).includes(project.id)) &&
            (where.readOnlyReason === undefined || project.readOnlyReason === where.readOnlyReason),
        );
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
      create: async ({ data }: { data: Partial<Project> & { ownerId: string; name: string } }) => {
        const now = new Date();
        const project: Project = {
          id: randomUUID(),
          kind: 'DOCUMENT',
          engine: 'PDFLATEX',
          mainFilePath: 'main.tex',
          autoCompile: false,
          readOnlyReason: null,
          templateId: null,
          lastActivityAt: now,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        this.projects.push(project);
        return project;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Project> }) => {
        const project = this.project(where.id);
        for (const [key, value] of Object.entries(data)) {
          if (value !== undefined) Object.assign(project, { [key]: value });
        }
        return project;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        this.projects = this.projects.filter((project) => project.id !== where.id);
      },
    },
    projectFolder: {
      findMany: async ({ where }: { where: { projectId: string } }) =>
        this.folders
          .filter((folder) => folder.projectId === where.projectId)
          .map((folder) => ({ ...folder })),
      count: async ({ where }: { where: { projectId: string } }) =>
        this.folders.filter((folder) => folder.projectId === where.projectId).length,
      create: async ({ data }: { data: { projectId: string; path: string } }) => {
        if (this.folders.some((f) => f.projectId === data.projectId && f.path === data.path)) {
          throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
        }
        const folder: ProjectFolder = { id: randomUUID(), createdAt: new Date(), ...data };
        this.folders.push(folder);
        return { ...folder };
      },
      createMany: async ({
        data,
        skipDuplicates,
      }: {
        data: { projectId: string; path: string }[];
        skipDuplicates?: boolean;
      }) => {
        let count = 0;
        for (const row of data) {
          const exists = this.folders.some(
            (f) => f.projectId === row.projectId && f.path === row.path,
          );
          if (exists && skipDuplicates) continue;
          if (exists) throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
          this.folders.push({ id: randomUUID(), createdAt: new Date(), ...row });
          count++;
        }
        return { count };
      },
      deleteMany: async ({ where }: { where: { projectId: string; path?: { in: string[] } } }) => {
        const before = this.folders.length;
        this.folders = this.folders.filter(
          (f) => f.projectId !== where.projectId || (where.path && !where.path.in.includes(f.path)),
        );
        return { count: before - this.folders.length };
      },
    },
    projectFile: {
      findMany: async ({ where }: { where: Where }) =>
        this.files
          .filter((file) => this.matchesFile(file, where))
          .sort((a, b) => a.path.localeCompare(b.path))
          .map((file) => ({ ...file })),
      findFirst: async ({ where }: { where: Where }) => {
        // Prisma returns copies: later updates never change an object already read.
        const file = this.files.find((item) => this.matchesFile(item, where));
        return file ? { ...file } : null;
      },
      findUnique: async ({
        where,
      }: {
        where: { projectId_path: { projectId: string; path: string } };
      }) =>
        this.files.find(
          (file) =>
            file.projectId === where.projectId_path.projectId &&
            file.path === where.projectId_path.path,
        ) ?? null,
      create: async ({ data }: { data: Partial<ProjectFile> }) => {
        const file = this.newFile(data);
        return file;
      },
      createMany: async ({ data }: { data: Partial<ProjectFile>[] }) => {
        for (const row of data) this.newFile(row);
        return { count: data.length };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<ProjectFile> }) => {
        const file = this.files.find((item) => item.id === where.id)!;
        // PostgreSQL text never holds NUL.
        if (data.path?.includes('\u0000')) throw new Error('invalid byte sequence for UTF8');
        if (data.path && data.path !== file.path) this.checkUnique(file.projectId, data.path);
        Object.assign(file, data, { updatedAt: new Date() });
        return file;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        this.files = this.files.filter((file) => file.id !== where.id);
        // ON DELETE CASCADE, and SET NULL on comments
        this.documents.delete(where.id);
        for (const comment of this.comments) if (comment.fileId === where.id) comment.fileId = null;
      },
      count: async ({ where }: { where: Where }) =>
        this.files.filter((file) => this.matchesFile(file, where)).length,
      updateMany: async ({ where, data }: { where: Where; data: Partial<ProjectFile> }) => {
        const rows = this.files.filter((file) => this.matchesFile(file, where));
        for (const file of rows) Object.assign(file, data, { updatedAt: new Date() });
        return { count: rows.length };
      },
      deleteMany: async ({ where }: { where: Where }) => {
        const before = this.files.length;
        const gone = this.files.filter((file) => this.matchesFile(file, where));
        this.files = this.files.filter((file) => !this.matchesFile(file, where));
        for (const file of gone) this.documents.delete(file.id);
        // SET NULL on comments
        const goneIds = new Set(gone.map((file) => file.id));
        for (const comment of this.comments) {
          if (comment.fileId && goneIds.has(comment.fileId)) comment.fileId = null;
        }
        return { count: before - this.files.length };
      },
      aggregate: async ({ where }: { where: Where }) => ({
        _sum: {
          sizeBytes: this.files
            .filter((file) => this.matchesFile(file, where))
            .reduce((total, file) => total + file.sizeBytes, 0),
        },
      }),
      groupBy: async ({ where }: { where: Where }) => {
        const sums = new Map<string, number>();
        for (const file of this.files.filter((item) => this.matchesFile(item, where))) {
          sums.set(file.projectId, (sums.get(file.projectId) ?? 0) + file.sizeBytes);
        }
        return [...sums].map(([projectId, sizeBytes]) => ({ projectId, _sum: { sizeBytes } }));
      },
    },
  };

  private checkUnique(projectId: string, path: string): void {
    if (this.files.some((file) => file.projectId === projectId && file.path === path)) {
      throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
    }
  }

  private newFile(data: Partial<ProjectFile>): ProjectFile {
    this.checkUnique(data.projectId!, data.path!);
    const now = new Date();
    const file: ProjectFile = {
      id: randomUUID(),
      projectId: data.projectId!,
      path: data.path!,
      kind: data.kind ?? 'TEXT',
      storageKey: data.storageKey ?? null,
      sizeBytes: data.sizeBytes ?? 0,
      lockedBySubmissionId: data.lockedBySubmissionId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.files.push(file);
    return file;
  }
}

/** In-memory object storage. */
export class FakeStorage {
  objects = new Map<string, Uint8Array>();

  async put(bucket: string, key: string, body: Uint8Array): Promise<void> {
    this.objects.set(`${bucket}/${key}`, body);
  }
  async copy(bucket: string, from: string, to: string): Promise<void> {
    this.objects.set(`${bucket}/${to}`, await this.get(bucket, from));
  }
  async exists(bucket: string, key: string): Promise<boolean> {
    return this.objects.has(`${bucket}/${key}`);
  }
  async get(bucket: string, key: string): Promise<Uint8Array> {
    const body = this.objects.get(`${bucket}/${key}`);
    if (!body) throw new Error('NoSuchKey');
    return body;
  }
  async deleteKeys(bucket: string, keys: string[]): Promise<void> {
    for (const key of keys) this.objects.delete(`${bucket}/${key}`);
  }
  async presignGet(bucket: string, key: string, seconds: number): Promise<string> {
    return `http://127.0.0.1:9000/${bucket}/${key}?X-Amz-Expires=${seconds}&X-Amz-Signature=test`;
  }
  async open(bucket: string, key: string) {
    const body = this.objects.get(`${bucket}/${key}`);
    return body
      ? { body: Readable.from([Buffer.from(body)]), size: body.length, encoding: undefined }
      : null;
  }
  async deletePrefix(bucket: string, prefix: string): Promise<void> {
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(`${bucket}/${prefix}`)) this.objects.delete(key);
    }
  }
  onModuleDestroy(): void {}
}
