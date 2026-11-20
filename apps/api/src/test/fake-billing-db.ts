import { randomUUID } from 'node:crypto';

// In-memory stand-in for the Prisma calls of the billing module. Unlike FakeProjectsDb, whose
// methods match the exact call shapes of the projects module, this one interprets the Prisma
// arguments it is given (where with operators, AND/OR, include of the relations listed below,
// increments, unique constraints), because payments touch many tables in one transaction.

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

interface Relation {
  model: string;
  /** Field of this row and field of the related row that must be equal. */
  local: string;
  foreign: string;
  many: boolean;
}

const RELATIONS: Record<string, Record<string, Relation>> = {
  subscription: {
    plan: { model: 'plan', local: 'planId', foreign: 'id', many: false },
    organization: { model: 'organization', local: 'organizationId', foreign: 'id', many: false },
    user: { model: 'user', local: 'userId', foreign: 'id', many: false },
    seats: { model: 'seat', local: 'id', foreign: 'subscriptionId', many: true },
  },
  seat: {
    subscription: { model: 'subscription', local: 'subscriptionId', foreign: 'id', many: false },
  },
  payment: {
    receipt: { model: 'receipt', local: 'id', foreign: 'paymentId', many: false },
    credits: { model: 'creditEntry', local: 'id', foreign: 'paymentId', many: true },
    subscription: { model: 'subscription', local: 'subscriptionId', foreign: 'id', many: false },
    user: { model: 'user', local: 'userId', foreign: 'id', many: false },
  },
  receipt: {
    payment: { model: 'payment', local: 'paymentId', foreign: 'id', many: false },
  },
};

/** Unique fields (or field groups) per model: a duplicate throws P2002 like PostgreSQL. */
const UNIQUE: Record<string, string[][]> = {
  user: [['phone'], ['email']],
  plan: [['code']],
  subscription: [['organizationId']],
  payment: [['providerToken'], ['providerTransactionId']],
  receipt: [['number'], ['paymentId']],
  promoCode: [['code']],
  promoRedemption: [['paymentId'], ['promoCodeId', 'userId']],
  notification: [['dedupeKey']],
  membership: [['organizationId', 'userId']],
};

const DEFAULTS: Record<string, () => Row> = {
  subscription: () => ({
    userId: null,
    organizationId: null,
    seatCount: 1,
    graceEndsAt: null,
    pausedAt: null,
    pausedRemainingDays: null,
    pendingPlanId: null,
    pendingBillingPeriod: null,
    pendingSeatCount: null,
    pendingValueXof: null,
    paidValueXof: 0,
    paidFromAt: null,
    trialEndsAt: null,
  }),
  seat: () => ({ userId: null, assignedAt: null, releasedAt: null, reassignableAt: null }),
  payment: () => ({
    subscriptionId: null,
    seats: 1,
    status: 'PENDING',
    provider: 'LIGDICASH',
    providerToken: null,
    providerTransactionId: null,
    providerRaw: null,
    verifiedAt: null,
    creditUsedXof: 0,
    promoCodeId: null,
    locale: 'fr',
    checkoutUrl: null,
    duplicateReason: null,
    lastCheckedAt: null,
  }),
  receipt: () => ({ emailedAt: null }),
  creditEntry: () => ({ paymentId: null }),
  organization: () => ({ ifu: null }),
  membership: () => ({
    kind: 'OTHER',
    status: 'ACTIVE',
    approvedById: null,
    approvedAt: null,
    groupId: null,
  }),
  notification: () => ({ channel: 'IN_APP', dedupeKey: null, sentAt: null, readAt: null }),
  promoCode: () => ({
    planCodes: [],
    validUntil: null,
    maxRedemptions: null,
    redemptionCount: 0,
    isActive: true,
  }),
  auditLog: () => ({ actorId: null, metadata: null, ip: null }),
};

const MODELS = [
  'user',
  'plan',
  'subscription',
  'seat',
  'organization',
  'membership',
  'payment',
  'creditEntry',
  'receipt',
  'billingCounter',
  'promoCode',
  'promoRedemption',
  'notification',
  'auditLog',
] as const;
type Model = (typeof MODELS)[number];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value);

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

function compare(a: unknown, b: unknown): number {
  const value = (x: unknown) => (x instanceof Date ? x.getTime() : (x as number));
  return value(a) - value(b);
}

const OPERATORS = new Set(['in', 'notIn', 'not', 'lt', 'lte', 'gt', 'gte', 'equals', 'has']);

function matchesField(value: unknown, condition: unknown): boolean {
  if (!isPlainObject(condition) || !Object.keys(condition).every((key) => OPERATORS.has(key))) {
    return same(value, condition);
  }
  for (const [op, operand] of Object.entries(condition)) {
    if (op === 'equals' && !same(value, operand)) return false;
    if (op === 'in' && !(operand as unknown[]).some((item) => same(value, item))) return false;
    if (op === 'notIn' && (operand as unknown[]).some((item) => same(value, item))) return false;
    if (op === 'not' && matchesField(value, operand)) return false;
    if (op === 'has' && !(value as unknown[]).includes(operand)) return false;
    if (['lt', 'lte', 'gt', 'gte'].includes(op)) {
      if (value === null || value === undefined) return false;
      const diff = compare(value, operand);
      if (op === 'lt' && !(diff < 0)) return false;
      if (op === 'lte' && !(diff <= 0)) return false;
      if (op === 'gt' && !(diff > 0)) return false;
      if (op === 'gte' && !(diff >= 0)) return false;
    }
  }
  return true;
}

export class FakeBillingDb {
  tables: Record<Model, Row[]> = Object.fromEntries(
    MODELS.map((model) => [model, [] as Row[]]),
  ) as Record<Model, Row[]>;

  reset(): void {
    for (const model of MODELS) this.tables[model] = [];
  }

  private matches(model: string, row: Row, where: Where | undefined): boolean {
    if (!where) return true;
    for (const [key, condition] of Object.entries(where)) {
      if (condition === undefined) continue;
      if (key === 'AND') {
        if (!(condition as Where[]).every((part) => this.matches(model, row, part))) return false;
      } else if (key === 'OR') {
        if (!(condition as Where[]).some((part) => this.matches(model, row, part))) return false;
      } else if (key === 'NOT') {
        if (this.matches(model, row, condition as Where)) return false;
      } else if (RELATIONS[model]?.[key]) {
        const related = this.related(model, row, key);
        const rows = Array.isArray(related) ? related : related ? [related] : [];
        const target = RELATIONS[model]![key]!.model;
        if (!rows.some((item) => this.matches(target, item, condition as Where))) return false;
      } else if (key.includes('_') && isPlainObject(condition) && !(key in row)) {
        // Compound unique key (promoCodeId_userId).
        if (!this.matches(model, row, condition)) return false;
      } else if (!matchesField(row[key] ?? null, condition)) {
        return false;
      }
    }
    return true;
  }

  private related(model: string, row: Row, name: string): Row | Row[] | null {
    const relation = RELATIONS[model]![name]!;
    const rows = this.tables[relation.model as Model].filter((item) =>
      same(item[relation.foreign], row[relation.local]),
    );
    return relation.many ? rows : (rows[0] ?? null);
  }

  /** Copy of a row with the included relations (`include` or relations named in `select`). */
  private shape(model: string, row: Row, include?: Record<string, unknown>): Row {
    const result: Row = { ...row };
    for (const [name, spec] of Object.entries(include ?? {})) {
      if (!spec || !RELATIONS[model]?.[name]) continue;
      const relation = RELATIONS[model]![name]!;
      const options = isPlainObject(spec) ? spec : {};
      const nested = (options.include ?? options.select) as Record<string, unknown> | undefined;
      const value = this.related(model, row, name);
      if (Array.isArray(value)) {
        result[name] = value
          .filter((item) => this.matches(relation.model, item, options.where as Where))
          .map((item) => this.shape(relation.model, item, nested));
      } else {
        result[name] = value ? this.shape(relation.model, value, nested) : null;
      }
    }
    return result;
  }

  private checkUnique(model: string, row: Row): void {
    for (const fields of UNIQUE[model] ?? []) {
      if (fields.some((field) => row[field] === null || row[field] === undefined)) continue;
      const clash = this.tables[model as Model].some(
        (other) => other !== row && fields.every((field) => same(other[field], row[field])),
      );
      if (clash) throw Object.assign(new Error(`Unique constraint ${fields}`), { code: 'P2002' });
    }
  }

  private applyData(row: Row, data: Row): void {
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (isPlainObject(value) && 'increment' in value) {
        row[key] = (row[key] as number) + (value.increment as number);
      } else if (isPlainObject(value) && 'decrement' in value) {
        row[key] = (row[key] as number) - (value.decrement as number);
      } else {
        row[key] = value;
      }
    }
    if ('updatedAt' in row) row.updatedAt = new Date();
  }

  insert(model: Model, data: Row): Row {
    const now = new Date();
    const row: Row = {
      id: randomUUID().replace(/-/g, '').slice(0, 25),
      createdAt: now,
      ...(DEFAULTS[model]?.() ?? {}),
      ...data,
    };
    if (['subscription', 'payment', 'organization', 'plan', 'user'].includes(model)) {
      row.updatedAt = now;
    }
    this.checkUnique(model, row);
    this.tables[model].push(row);
    return row;
  }

  private delegate(model: Model) {
    const table = () => this.tables[model];
    const find = (args: { where?: Where; orderBy?: unknown; take?: number } = {}) => {
      let rows = table().filter((row) => this.matches(model, row, args.where));
      const orders = Array.isArray(args.orderBy)
        ? args.orderBy
        : args.orderBy
          ? [args.orderBy]
          : [];
      for (const order of [...orders].reverse() as Record<string, 'asc' | 'desc'>[]) {
        const [[field, direction]] = Object.entries(order) as [[string, 'asc' | 'desc']];
        rows = [...rows].sort(
          (a, b) => compare(a[field], b[field]) * (direction === 'desc' ? -1 : 1),
        );
      }
      return args.take === undefined ? rows : rows.slice(0, args.take);
    };
    type Args = { where?: Where; include?: Row; select?: Row; orderBy?: unknown; take?: number };
    const shape = (row: Row, args: Args) => this.shape(model, row, args.include ?? args.select);
    return {
      findUnique: async (args: Args) => {
        const row = find(args)[0];
        return row ? shape(row, args) : null;
      },
      findFirst: async (args: Args = {}) => {
        const row = find(args)[0];
        return row ? shape(row, args) : null;
      },
      findUniqueOrThrow: async (args: Args) => {
        const row = find(args)[0];
        if (!row) throw Object.assign(new Error(`${model} not found`), { code: 'P2025' });
        return shape(row, args);
      },
      findMany: async (args: Args = {}) => find(args).map((row) => shape(row, args)),
      count: async (args: Args = {}) => find(args).length,
      aggregate: async (args: { where?: Where; _sum: Record<string, boolean> }) => {
        const rows = find(args);
        const sum = Object.fromEntries(
          Object.keys(args._sum).map((field) => [
            field,
            rows.length ? rows.reduce((total, row) => total + (row[field] as number), 0) : null,
          ]),
        );
        return { _sum: sum };
      },
      create: async (args: { data: Row; include?: Row }) =>
        this.shape(model, this.insert(model, args.data), args.include),
      createMany: async (args: { data: Row[]; skipDuplicates?: boolean }) => {
        let count = 0;
        for (const data of args.data) {
          try {
            this.insert(model, data);
            count++;
          } catch (error) {
            if (!args.skipDuplicates || (error as { code?: string }).code !== 'P2002') throw error;
          }
        }
        return { count };
      },
      update: async (args: { where: Where; data: Row; include?: Row }) => {
        const row = find(args)[0];
        if (!row) throw Object.assign(new Error(`${model} not found`), { code: 'P2025' });
        const before = { ...row };
        this.applyData(row, args.data);
        try {
          this.checkUnique(model, row);
        } catch (error) {
          Object.assign(row, before);
          throw error;
        }
        return this.shape(model, row, args.include);
      },
      updateMany: async (args: { where: Where; data: Row }) => {
        const rows = find(args);
        for (const row of rows) this.applyData(row, args.data);
        return { count: rows.length };
      },
      upsert: async (args: { where: Where; create: Row; update: Row }) => {
        const row = find(args)[0];
        if (row) {
          this.applyData(row, args.update);
          return { ...row };
        }
        return { ...this.insert(model, args.create) };
      },
      delete: async (args: { where: Where }) => {
        const row = find(args)[0];
        if (!row) throw Object.assign(new Error(`${model} not found`), { code: 'P2025' });
        this.tables[model] = table().filter((item) => item !== row);
        return row;
      },
      deleteMany: async (args: { where?: Where } = {}) => {
        const rows = new Set(find(args));
        this.tables[model] = table().filter((item) => !rows.has(item));
        return { count: rows.size };
      },
    };
  }

  private snapshot(): Record<Model, Row[]> {
    return Object.fromEntries(
      MODELS.map((model) => [model, this.tables[model].map((row) => ({ ...row }))]),
    ) as Record<Model, Row[]>;
  }

  readonly client: Record<string, unknown> & {
    $transaction: (
      fn: ((tx: unknown) => Promise<unknown>) | Promise<unknown>[],
    ) => Promise<unknown>;
  } = {
    ...Object.fromEntries(MODELS.map((model) => [model, this.delegate(model)])),
    $transaction: async (fn) => {
      if (Array.isArray(fn)) return Promise.all(fn);
      const saved = this.snapshot();
      try {
        return await fn(this.client);
      } catch (error) {
        this.tables = saved;
        throw error;
      }
    },
  };

  // ───────────── Test data ─────────────

  addUser(data: Row = {}): Row {
    return this.insert('user', {
      phone: null,
      phoneVerifiedAt: null,
      email: null,
      emailVerifiedAt: null,
      passwordHash: null,
      displayName: 'Awa Ouédraogo',
      locale: 'fr',
      editorSpellcheck: false,
      lastSpace: null,
      trialUsedAt: null,
      isSuperAdmin: false,
      disabledAt: null,
      ...data,
    });
  }

  addPlans(): void {
    const plan = (code: string, values: Row) =>
      this.insert('plan', {
        id: code,
        code,
        nameFr: code === 'FREE' ? 'Gratuit' : code[0] + code.slice(1).toLowerCase(),
        nameEn: code[0] + code.slice(1).toLowerCase(),
        volumeDiscountFromSeats: null,
        volumeDiscountPercent: null,
        trialDays: null,
        isActive: true,
        ...values,
      });
    plan('FREE', { priceMonthlyXof: 0, priceYearlyXof: 0, minSeats: 1, maxSeats: 1 });
    plan('STANDARD', {
      priceMonthlyXof: 2000,
      priceYearlyXof: 20000,
      minSeats: 1,
      maxSeats: 1,
      trialDays: 14,
    });
    plan('TEAM', { priceMonthlyXof: 2500, priceYearlyXof: 25000, minSeats: 2, maxSeats: 10 });
    plan('BUSINESS', {
      priceMonthlyXof: 2000,
      priceYearlyXof: 20000,
      minSeats: 10,
      maxSeats: null,
      volumeDiscountFromSeats: 100,
    });
    this.insert('billingCounter', { id: 'receipt', value: 0 });
  }

  rows(model: Model, where?: Where): Row[] {
    return this.tables[model].filter((row) => this.matches(model, row, where));
  }

  creditBalance(userId: string): number {
    return this.rows('creditEntry', { userId }).reduce(
      (sum, row) => sum + (row.amountXof as number),
      0,
    );
  }
}
