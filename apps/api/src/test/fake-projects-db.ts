import type { Plan, Project, ProjectFile, ProjectMember, ProjectRole, User } from '@integris/db';
import { randomUUID } from 'node:crypto';

type Where = Record<string, unknown>;

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
  projects: Project[] = [];
  files: ProjectFile[] = [];
  members: ProjectMember[] = [];
  /** Validated submissions (project id, submission id) and the submissions with a trace. */
  validated: { projectId: string; id: string }[] = [];
  traced = new Set<string>();

  reset(): void {
    this.plans = defaultPlans();
    this.users = [];
    this.personalPlans.clear();
    this.projects = [];
    this.files = [];
    this.members = [];
    this.validated = [];
    this.traced.clear();
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
    return true;
  }

  private planByCode(code: string): Plan {
    return this.plans.find((plan) => plan.code === code)!;
  }

  readonly client = {
    $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations),
    user: {
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
        return code ? [{ plan: this.planByCode(code) }] : [];
      },
    },
    seat: { findMany: async () => [] },
    printRequest: { count: async () => 0 },
    template: { findMany: async () => [], findFirst: async () => null },
    commentReply: { deleteMany: async () => ({ count: 0 }) },
    comment: { deleteMany: async () => ({ count: 0 }) },
    submissionReviewer: { deleteMany: async () => ({ count: 0 }) },
    submission: {
      findMany: async ({ where }: { where: { projectId: string } }) =>
        this.validated.filter((submission) => submission.projectId === where.projectId),
      deleteMany: async ({ where }: { where: { projectId: string } }) => {
        this.validated = this.validated.filter((item) => item.projectId !== where.projectId);
        return { count: 0 };
      },
    },
    validationRecord: {
      count: async ({ where }: { where: { submissionId: { in: string[] } } }) =>
        where.submissionId.in.filter((id) => this.traced.has(id)).length,
    },
    projectVersion: { deleteMany: async () => ({ count: 0 }) },
    compilation: { deleteMany: async () => ({ count: 0 }) },
    shareLink: { deleteMany: async () => ({ count: 0 }) },
    projectMember: {
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
      findMany: async ({ where, include }: { where: Where; include?: Where }) =>
        this.projects
          .filter((project) => this.matchesProject(project, where))
          .map((project) => this.withMembers(project, include)),
      count: async ({ where }: { where: Where }) =>
        this.projects.filter((project) => this.matchesProject(project, where)).length,
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
        if (data.path && data.path !== file.path) this.checkUnique(file.projectId, data.path);
        Object.assign(file, data, { updatedAt: new Date() });
        return file;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        this.files = this.files.filter((file) => file.id !== where.id);
      },
      deleteMany: async ({ where }: { where: Where }) => {
        const before = this.files.length;
        this.files = this.files.filter((file) => !this.matchesFile(file, where));
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
  async get(bucket: string, key: string): Promise<Uint8Array> {
    const body = this.objects.get(`${bucket}/${key}`);
    if (!body) throw new Error('NoSuchKey');
    return body;
  }
  async deleteKeys(bucket: string, keys: string[]): Promise<void> {
    for (const key of keys) this.objects.delete(`${bucket}/${key}`);
  }
  async deletePrefix(bucket: string, prefix: string): Promise<void> {
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(`${bucket}/${prefix}`)) this.objects.delete(key);
    }
  }
  onModuleDestroy(): void {}
}
