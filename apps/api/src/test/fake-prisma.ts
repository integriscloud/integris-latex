import type { Membership, Organization, User } from '@integris/db';
import { randomUUID } from 'node:crypto';

type UserWhere = { id?: string; phone?: string; email?: string };

/**
 * In-memory stand-in for the Prisma calls made by the auth module, so tests never write to the
 * shared development database.
 */
export class FakePrisma {
  users: User[] = [];
  memberships: (Membership & { organization: Organization })[] = [];

  private find(where: UserWhere): User | null {
    return (
      this.users.find(
        (user) =>
          (where.id === undefined || user.id === where.id) &&
          (where.phone === undefined || user.phone === where.phone) &&
          (where.email === undefined || user.email === where.email),
      ) ?? null
    );
  }

  private unique(data: Partial<User>, id?: string): void {
    for (const field of ['phone', 'email'] as const) {
      const value = data[field];
      if (value && this.users.some((user) => user[field] === value && user.id !== id)) {
        throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
      }
    }
  }

  addUser(data: Partial<User>): User {
    const user: User = {
      id: randomUUID(),
      phone: null,
      phoneVerifiedAt: null,
      email: null,
      emailVerifiedAt: null,
      passwordHash: null,
      displayName: 'Test User',
      locale: 'fr',
      editorSpellcheck: false,
      lastSpace: null,
      trialUsedAt: null,
      isSuperAdmin: false,
      disabledAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    };
    this.users.push(user);
    return user;
  }

  readonly client = {
    user: {
      findUnique: async ({ where }: { where: UserWhere }) => this.find(where),
      findUniqueOrThrow: async ({ where }: { where: UserWhere }) => {
        const user = this.find(where);
        if (!user) throw new Error('Not found');
        return user;
      },
      create: async ({ data }: { data: Partial<User> }) => {
        this.unique(data);
        return this.addUser(data);
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<User> }) => {
        const user = this.find(where);
        if (!user) throw new Error('Not found');
        this.unique(data, user.id);
        Object.assign(user, data);
        return user;
      },
    },
    membership: {
      findMany: async ({ where }: { where: { userId: string; status: string } }) =>
        this.memberships.filter(
          (membership) => membership.userId === where.userId && membership.status === where.status,
        ),
    },
  };
}
