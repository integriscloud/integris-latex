import { z } from 'zod';

// Team and Business organizations: seats, invitations, CSV import, join requests, admins,
// groups ("Classes et filières") and supervision (docs/spec.md, "Plans, comptes et membres",
// "Encadrement" and "Organisations et encadrement (décisions étape 12)").

/** Error codes of the organization, invitation, import, group and supervision endpoints. */
export const ORG_ERROR_CODES = [
  'org_not_found',
  // The caller is a member but not the owner or an admin (or not the owner for owner-only actions).
  'org_forbidden',
  // BUSINESS only (admins, groups, import, join code, supervision).
  'business_only',
  // The organization's subscription is not live (expired after its grace): no new seat.
  'subscription_inactive',
  'no_free_seat',
  'already_org_member',
  'already_org_invited',
  'admin_limit',
  'cannot_remove_owner',
  'owner_cannot_leave',
  'member_not_found',
  'join_code_invalid',
  'join_pending',
  'group_not_found',
  'group_name_taken',
  'group_not_empty',
  'group_cycle',
  'csv_invalid',
  'csv_too_large',
  'import_not_found',
  'not_teacher',
  'not_student',
  'supervision_limit',
  'supervision_exists',
  'supervision_not_found',
  'end_date_past',
  // The owner and the admins never hold the secretariat profile (step 13 decisions).
  'secretary_admin',
] as const;
export type OrgErrorCode = (typeof ORG_ERROR_CODES)[number];

/** A seat released by its holder can be given to someone else only after this many days. */
export const SEAT_REASSIGN_DAYS = 30;

/** An invitation to an organization can be accepted for this long. */
export const ORG_INVITATION_TTL_DAYS = 14;

/** CSV import limits (docs/spec.md, "Import CSV"). */
export const CSV_IMPORT_MAX_BYTES = 1024 * 1024;
export const CSV_IMPORT_MAX_ROWS = 2000;

/** Name of a group ("Classes et filières"). */
export const GROUP_NAME_MAX = 120;

/** Join code of a BUSINESS: 10 characters of Crockford's base32 (no I, L, O, U), shown in 2 halves. */
export const JOIN_CODE = /^[0-9A-HJKMNP-TV-Z]{10}$/;

/** Reads a typed join code: case, spaces and dashes do not matter; O, I and L read as 0, 1, 1. */
export function normalizeJoinCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

export function formatJoinCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Member kinds of the CSV import (docs/spec.md, "Import CSV": etudiant or enseignant). */
export const INVITED_KINDS = ['STUDENT', 'TEACHER'] as const;
export type InvitedKind = (typeof INVITED_KINDS)[number];
/**
 * Member kinds chosen when inviting one person into a BUSINESS or changing a member's profile.
 * A secretariat (step 13) serves one or more groups (`scopeGroupIds`).
 */
export const CHOSEN_KINDS = ['STUDENT', 'TEACHER', 'SECRETARY'] as const;
export type ChosenKind = (typeof CHOSEN_KINDS)[number];
/** Groups a secretariat serves, at most. */
export const SECRETARY_GROUPS_MAX = 20;

export const ORG_ROLES = ['OWNER', 'ADMIN', 'MEMBER'] as const;
export type OrgRoleValue = (typeof ORG_ROLES)[number];
export const MEMBER_KINDS = ['TEACHER', 'STUDENT', 'SECRETARY', 'OTHER'] as const;
export type MemberKindValue = (typeof MEMBER_KINDS)[number];

const date = z.iso.datetime();
const id = z.string().min(1).max(64);
const kind = z.enum(CHOSEN_KINDS);
const scopeGroupIds = z.array(id).min(1).max(SECRETARY_GROUPS_MAX);

// ───────────── Requests ─────────────

/** Invitation into an organization, by phone (with the dial code of the form) or e-mail. */
export const orgInviteSchema = z.discriminatedUnion('channel', [
  z.object({
    channel: z.literal('phone'),
    phone: z.string().trim().min(4).max(32),
    dialCode: z.string().regex(/^\d{1,4}$/),
    kind: kind.optional(),
    groupId: id.optional(),
    scopeGroupIds: scopeGroupIds.optional(),
  }),
  z.object({
    channel: z.literal('email'),
    email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
    kind: kind.optional(),
    groupId: id.optional(),
    scopeGroupIds: scopeGroupIds.optional(),
  }),
]);
export type OrgInviteRequest = z.input<typeof orgInviteSchema>;

/** Changes to a member: kind, group (null = none), admin role (owner only). */
export const updateMemberSchema = z
  .object({
    kind: kind.optional(),
    groupId: id.nullable().optional(),
    admin: z.boolean().optional(),
    /** Groups served by a secretariat member (with `kind: 'SECRETARY'`, or for one already). */
    scopeGroupIds: scopeGroupIds.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'empty' });

export const joinOrganizationSchema = z.object({
  code: z.string().max(32).transform(normalizeJoinCode).pipe(z.string().regex(JOIN_CODE)),
});

export const approveJoinSchema = z.object({ groupId: id.nullable().optional() });

/** A member chooses their own group, when the organization allows it (null = none). */
export const chooseGroupSchema = z.object({ groupId: id.nullable() });

/** Settings of a BUSINESS changed by its owner or admins. */
export const orgSettingsSchema = z.object({ membersChooseGroup: z.boolean() });

export const groupSchemaIn = z.object({
  name: z.string().trim().min(1).max(GROUP_NAME_MAX),
  parentId: id.nullable().optional(),
});

export const assignSupervisorSchema = z.object({
  supervisorId: id,
  studentId: id,
  /** Day the link ends by itself (ISO date-time), optional. */
  endsAt: date.nullable().optional(),
});

export const updateSupervisionSchema = z.object({ endsAt: date.nullable() });

export const reassignSupervisionSchema = z.object({ supervisorId: id });

export const requestSupervisorSchema = z.object({ supervisorId: id });

export const supervisionProjectSchema = z.object({ projectId: id });

// ───────────── Views ─────────────

export const seatSummarySchema = z.object({
  total: z.number().int(),
  /** Occupied by a member. */
  held: z.number().int(),
  /** Reserved by a pending invitation. */
  reserved: z.number().int(),
  /** Released less than 30 days ago: not reassignable yet. */
  waiting: z.number().int(),
  free: z.number().int(),
  /** When the next waiting seat becomes free again. */
  nextFreeAt: date.nullable(),
});
export type SeatSummary = z.infer<typeof seatSummarySchema>;

export const memberUsageSchema = z.object({
  projects: z.number().int(),
  storageBytes: z.number().int(),
  compiles: z.number().int(),
  compileSeconds: z.number().int(),
});
export type MemberUsage = z.infer<typeof memberUsageSchema>;

export const orgMemberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  /** Masked phone number or e-mail address (identity check, never the full contact). */
  contactHint: z.string().nullable(),
  role: z.enum(ORG_ROLES),
  kind: z.enum(MEMBER_KINDS),
  groupId: z.string().nullable(),
  /** SECRETARY: the groups served. */
  scopeGroupIds: z.array(z.string()),
  joinedAt: date,
  /** Consumption of the month: counts only, never the projects themselves. */
  usage: memberUsageSchema,
});
export type OrgMember = z.infer<typeof orgMemberSchema>;

export const orgInvitationSchema = z.object({
  id: z.string(),
  channel: z.enum(['phone', 'email']),
  /** As typed by the owner or an admin. */
  contact: z.string(),
  displayName: z.string().nullable(),
  kind: z.enum(MEMBER_KINDS),
  groupId: z.string().nullable(),
  scopeGroupIds: z.array(z.string()),
  createdAt: date,
  expiresAt: date,
});
export type OrgInvitation = z.infer<typeof orgInvitationSchema>;

export const joinRequestSchema = z.object({
  userId: z.string(),
  name: z.string(),
  /** A teacher joining (takes a seat), or a student member asking to become a teacher. */
  type: z.enum(['join', 'teacher']),
  contactHint: z.string().nullable(),
  requestedAt: date,
});
export type JoinRequest = z.infer<typeof joinRequestSchema>;

export const orgGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable(),
  members: z.number().int(),
});
export type OrgGroup = z.infer<typeof orgGroupSchema>;

/** Organization as seen by one of its members. Management data only for the owner and admins. */
export const organizationViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['TEAM', 'BUSINESS']),
  me: z.object({
    role: z.enum(ORG_ROLES),
    kind: z.enum(MEMBER_KINDS),
    /** Owner or admin: manages members. */
    manages: z.boolean(),
    groupId: z.string().nullable(),
    /** Asked with the join code to become a teacher, waiting for an admin. */
    teacherRequested: z.boolean(),
  }),
  /** BUSINESS: members may choose their own group. */
  membersChooseGroup: z.boolean(),
  /** Groups, given to managers and, when members choose theirs, to every member. */
  groups: z.array(orgGroupSchema).nullable(),
  subscription: z.object({
    planCode: z.enum(['TEAM', 'BUSINESS']),
    live: z.boolean(),
    periodEnd: date,
    /** Subscription id, for the owner's payment links (extra seats, renewal). */
    id: z.string(),
  }),
  seats: seatSummarySchema.nullable(),
  admins: z.object({ count: z.number().int(), max: z.number().int() }).nullable(),
  /** BUSINESS, managers only. */
  joinCode: z.string().nullable(),
  counts: z
    .object({
      teachers: z.number().int(),
      students: z.number().int(),
      others: z.number().int(),
      joinRequests: z.number().int(),
      invitations: z.number().int(),
    })
    .nullable(),
  /** Supervision dashboard of the plan (BUSINESS) and its limit per supervisor. */
  supervision: z.object({ enabled: z.boolean(), maxStudents: z.number().int().nullable() }),
});
export type OrganizationView = z.infer<typeof organizationViewSchema>;

export const membersPageSchema = z.object({
  members: z.array(orgMemberSchema),
  invitations: z.array(orgInvitationSchema),
  joinRequests: z.array(joinRequestSchema),
  groups: z.array(orgGroupSchema),
  seats: seatSummarySchema,
});
export type MembersPage = z.infer<typeof membersPageSchema>;

export const CSV_ROW_ERRORS = [
  'contact_missing',
  'contact_invalid',
  'country_not_allowed',
  'kind_invalid',
  'group_unknown',
  'duplicate_row',
  'already_member',
  'already_invited',
  'no_free_seat',
  'not_sent',
] as const;
export type CsvRowError = (typeof CSV_ROW_ERRORS)[number];

export const importReportSchema = z.object({
  id: z.string(),
  status: z.enum(['PENDING', 'PROCESSING', 'DONE', 'FAILED']),
  fileName: z.string().nullable(),
  totalRows: z.number().int(),
  invitedCount: z.number().int(),
  errors: z.array(
    z.object({ line: z.number().int(), reason: z.enum(CSV_ROW_ERRORS), contact: z.string() }),
  ),
  createdAt: date,
  finishedAt: date.nullable(),
});
export type ImportReport = z.infer<typeof importReportSchema>;

/** Invitation page of an organization (read with the token, without being signed in). */
export const orgInvitationViewSchema = z.object({
  organizationName: z.string(),
  organizationType: z.enum(['TEAM', 'BUSINESS']),
  inviterName: z.string(),
  kind: z.enum(MEMBER_KINDS),
  channel: z.enum(['phone', 'email']),
  contactHint: z.string(),
  status: z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'REVOKED']),
  expiresAt: date,
});
export type OrgInvitationView = z.infer<typeof orgInvitationViewSchema>;

export const joinResultSchema = z.object({
  organizationName: z.string(),
  status: z.enum(['PENDING_APPROVAL', 'ACTIVE']),
});
export type JoinResult = z.infer<typeof joinResultSchema>;

/** A pending join request of the signed-in user (shown on "Choisir son espace"). */
export const myJoinRequestSchema = z.object({
  organizationId: z.string(),
  organizationName: z.string(),
  requestedAt: date,
});
export type MyJoinRequest = z.infer<typeof myJoinRequestSchema>;
export const myJoinRequestsSchema = z.array(myJoinRequestSchema);

// ───────────── Supervision ─────────────

export const SUPERVISION_STATUSES = ['PENDING', 'ACTIVE', 'ENDED'] as const;

const person = z.object({ id: z.string(), name: z.string() });

/** A supervision link as the admins see it. */
export const supervisionLinkSchema = z.object({
  id: z.string(),
  supervisor: person,
  student: person.extend({ groupId: z.string().nullable() }),
  status: z.enum(SUPERVISION_STATUSES),
  /** Assigned by an admin (true) or asked by the student (false). */
  assigned: z.boolean(),
  startsAt: date,
  endsAt: date.nullable(),
});
export type SupervisionLink = z.infer<typeof supervisionLinkSchema>;

export const supervisionAdminSchema = z.object({
  links: z.array(supervisionLinkSchema),
  teachers: z.array(person.extend({ students: z.number().int() })),
  students: z.array(person.extend({ groupId: z.string().nullable() })),
  groups: z.array(orgGroupSchema),
  maxStudents: z.number().int().nullable(),
});
export type SupervisionAdmin = z.infer<typeof supervisionAdminSchema>;

/** A student's side: their supervisors, the projects opened to them, the teachers to ask. */
export const mySupervisorsSchema = z.object({
  links: z.array(
    z.object({
      id: z.string(),
      supervisor: person,
      status: z.enum(['PENDING', 'ACTIVE']),
      endsAt: date.nullable(),
      projects: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  ),
  teachers: z.array(person),
  /** Projects the student owns (outside the trash), to open to a supervisor. */
  projects: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type MySupervisors = z.infer<typeof mySupervisorsSchema>;

/** One row of the supervision dashboard: a project opened by a followed student. */
export const dashboardRowSchema = z.object({
  supervisionId: z.string(),
  student: person.extend({ group: z.string().nullable() }),
  project: z.object({ id: z.string(), name: z.string() }).nullable(),
  submission: z
    .object({
      id: z.string(),
      title: z.string().nullable(),
      status: z.enum(['DRAFT', 'SUBMITTED', 'IN_REVIEW', 'FEEDBACK_SENT', 'REVISED', 'VALIDATED']),
      dueAt: date.nullable(),
    })
    .nullable(),
  submissions: z.number().int(),
  lastActivityAt: date.nullable(),
  /** Overdue, to review, due soon, or nothing pressing (sort order). */
  urgency: z.enum(['overdue', 'to_review', 'due_soon', 'none']),
});
export type DashboardRow = z.infer<typeof dashboardRowSchema>;

export const supervisionDashboardSchema = z.object({
  rows: z.array(dashboardRowSchema),
  students: z.number().int(),
  maxStudents: z.number().int().nullable(),
  /** Students who asked this teacher to supervise them. */
  requests: z.array(
    z.object({
      id: z.string(),
      student: person.extend({ group: z.string().nullable() }),
      createdAt: date,
    }),
  ),
});
export type SupervisionDashboard = z.infer<typeof supervisionDashboardSchema>;

const URGENCY_ORDER = ['overdue', 'to_review', 'due_soon', 'none'] as const;

/** Submission statuses waiting for the supervisor. */
const TO_REVIEW = new Set(['SUBMITTED', 'IN_REVIEW', 'REVISED']);

/** A due date is "soon" within this many days. */
export const DUE_SOON_DAYS = 7;

/** Urgency of a dashboard row (docs/spec.md, "Tableau d'encadrement"). */
export function urgencyOf(
  submission: { status: string; dueAt: Date | null } | null,
  now: Date,
): DashboardRow['urgency'] {
  if (!submission || submission.status === 'VALIDATED') return 'none';
  if (submission.dueAt && submission.dueAt < now) return 'overdue';
  if (TO_REVIEW.has(submission.status)) return 'to_review';
  if (submission.dueAt && submission.dueAt.getTime() - now.getTime() < DUE_SOON_DAYS * 86_400_000)
    return 'due_soon';
  return 'none';
}

/**
 * Dashboard order: overdue, then to review, then due soon; inside each, the nearest due date
 * first, then the oldest activity first.
 */
export function compareDashboardRows(a: DashboardRow, b: DashboardRow): number {
  const rank = URGENCY_ORDER.indexOf(a.urgency) - URGENCY_ORDER.indexOf(b.urgency);
  if (rank) return rank;
  // The due date of a validated submission no longer matters.
  const due = (row: DashboardRow) =>
    row.submission?.dueAt && row.submission.status !== 'VALIDATED'
      ? Date.parse(row.submission.dueAt)
      : Number.POSITIVE_INFINITY;
  if (due(a) !== due(b)) return due(a) < due(b) ? -1 : 1;
  const active = (row: DashboardRow) =>
    row.lastActivityAt ? Date.parse(row.lastActivityAt) : Number.NEGATIVE_INFINITY;
  return active(a) - active(b);
}

// ───────────── CSV import ─────────────

export interface CsvMemberRow {
  /** Line number in the file (the header is line 1). */
  line: number;
  name: string;
  phone: string;
  email: string;
  kind: string;
  group: string;
}

const HEADERS: Record<string, keyof Omit<CsvMemberRow, 'line'>> = {
  nom: 'name',
  name: 'name',
  telephone: 'phone',
  phone: 'phone',
  email: 'email',
  mail: 'email',
  profil: 'kind',
  profile: 'kind',
  classe: 'group',
  group: 'group',
  class: 'group',
};

const KINDS: Record<string, InvitedKind> = {
  etudiant: 'STUDENT',
  student: 'STUDENT',
  enseignant: 'TEACHER',
  teacher: 'TEACHER',
};

/** Lower case without accents: "Téléphone" → "telephone", "Étudiant" → "etudiant". */
const fold = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();

export function kindOfCsv(value: string): InvitedKind | null {
  return KINDS[fold(value)] ?? null;
}

/** Splits CSV text into records (RFC 4180 quotes, CRLF or LF). */
function records(text: string, separator: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === '') {
      quoted = true;
    } else if (char === separator) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Reads the member CSV (UTF-8, ";" or "," separator, header line with the columns nom,
 * telephone, email, profil, classe in any order). Blank lines are skipped. Returns null when
 * the file is not such a CSV (no known header, no name or contact column).
 */
export function parseMembersCsv(text: string): CsvMemberRow[] | null {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const firstLine = body.split(/\r?\n/, 1)[0] ?? '';
  const separator =
    (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const all = records(body, separator);
  if (!all.length) return null;
  const columns = all[0]!.map((header) => HEADERS[fold(header).replace(/[^a-z]/g, '')] ?? null);
  if (!columns.includes('phone') && !columns.includes('email')) return null;
  const rows: CsvMemberRow[] = [];
  all.slice(1).forEach((cells, index) => {
    if (cells.every((cell) => cell.trim() === '')) return;
    const row: CsvMemberRow = {
      line: index + 2,
      name: '',
      phone: '',
      email: '',
      kind: '',
      group: '',
    };
    cells.forEach((cell, column) => {
      const key = columns[column];
      if (key) row[key] = cell.trim();
    });
    rows.push(row);
  });
  return rows;
}
