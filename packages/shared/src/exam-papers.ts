import { z } from 'zod';
import { COMPILE_OUTCOMES, compileIssueSchema } from './compile.js';

/**
 * Exam papers and secretariat (docs/spec.md, "Devoirs et secrétariat", BUSINESS only): a teacher
 * writes an exam paper (subject, private answer key, marking scheme), sends the frozen compiled
 * subject to the secretariat of a class, which may open it only from a date set by the teacher.
 */

export const EXAM_ERROR_CODES = [
  // Creating an exam paper or sending it needs an active teacher of a live BUSINESS.
  'exam_teacher_only',
  // Not an exam paper, or an action refused on exam papers (public link, submission, ZIP...).
  'exam_paper_only',
  'exam_not_allowed',
  // Subject, answer key and marking scheme files cannot be renamed, moved or deleted.
  'exam_part_protected',
  // Dates: available before the exam, exam in the future.
  'exam_dates_invalid',
  // No secretariat serves the chosen class.
  'no_secretariat',
  // A send of this exam paper is still compiling.
  'exam_send_pending',
  // The print request is not in a status that allows the action.
  'print_status',
  // The subject cannot be opened before its availability date, by anyone.
  'print_locked',
  'print_not_found',
  // Co-editors: teachers of an organization of the owner only.
  'coeditor_invalid',
  // A secretariat member serves at least one group.
  'secretary_groups_required',
  // A group served by a secretariat or used by a print request cannot be deleted.
  'group_in_use',
  // Official template: ZIP without any accepted file.
  'template_empty',
  'template_not_found',
] as const;
export type ExamErrorCode = (typeof EXAM_ERROR_CODES)[number];

/** The three parts of an exam paper, as fixed files at the root of the project. */
export const EXAM_PARTS = ['subject', 'answers', 'marking'] as const;
export type ExamPart = (typeof EXAM_PARTS)[number];
export const EXAM_PART_FILES: Record<ExamPart, string> = {
  subject: 'sujet.tex',
  answers: 'corrige.tex',
  marking: 'bareme.tex',
};
/** Files that never leave the teacher's project: not even sent to the compilation of the subject. */
export const PRIVATE_EXAM_FILES: readonly string[] = [
  EXAM_PART_FILES.answers,
  EXAM_PART_FILES.marking,
];
export const isExamPartFile = (path: string): boolean =>
  (Object.values(EXAM_PART_FILES) as string[]).includes(path);

/** The clean print file is served by a one-time link valid this long (docs/spec.md). */
export const PRINT_LINK_TTL_SECONDS = 10 * 60;
/** Watermarked preview links: short-lived, renewed by the app while the page is open. */
export const PRINT_PREVIEW_TTL_SECONDS = 10 * 60;

export const PRINT_LIMITS = {
  titleMax: 120,
  copiesMax: 5000,
  reserveMax: 500,
  handedOverToMax: 120,
  printedMax: 100_000,
} as const;

export const PRINT_STATUSES = [
  'SCHEDULED',
  'READY',
  'OPENED',
  'PRINTED',
  'HANDED_OVER',
  'CANCELED',
] as const;
export type PrintStatusValue = (typeof PRINT_STATUSES)[number];

/** The teacher modifies or cancels a request until the secretariat opens it. */
export const PRINT_EDITABLE: readonly PrintStatusValue[] = ['SCHEDULED', 'READY'];
/** After opening, the teacher can only cancel (and send again), until the copies are handed over. */
export const PRINT_CANCELABLE: readonly PrintStatusValue[] = [
  'SCHEDULED',
  'READY',
  'OPENED',
  'PRINTED',
];

export const PRINT_EVENT_TYPES = [
  'REQUESTED',
  'UPDATED',
  'CANCELED',
  'OPENED',
  'DOWNLOADED',
  'PRINT_CONFIRMED',
  'HANDED_OVER',
  'COEDITOR_ADDED',
  'COEDITOR_REMOVED',
] as const;
export type PrintEventTypeValue = (typeof PRINT_EVENT_TYPES)[number];

const id = z.string().min(1).max(64);
const date = z.iso.datetime();
const name = z.string().trim().min(1).max(120);

// ───────────── Requests ─────────────

export const createExamPaperSchema = z.object({ name });
export type CreateExamPaperRequest = z.infer<typeof createExamPaperSchema>;

const printFields = {
  title: z.string().trim().min(1).max(PRINT_LIMITS.titleMax),
  groupId: id,
  copies: z.number().int().min(1).max(PRINT_LIMITS.copiesMax),
  reserveCopies: z.number().int().min(0).max(PRINT_LIMITS.reserveMax),
  duplex: z.enum(['SIMPLEX', 'DUPLEX']),
  stapled: z.boolean(),
  availableFrom: date,
  examAt: date,
};

/** A send to the secretariat: the subject is frozen and compiled, then the request is created. */
export const sendPrintSchema = z.object({ ...printFields, replacesId: id.optional() }).strict();
export type SendPrintRequest = z.infer<typeof sendPrintSchema>;

/** Changes to a request not opened yet. */
export const updatePrintSchema = z
  .object(printFields)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'empty' });
export type UpdatePrintRequest = z.infer<typeof updatePrintSchema>;

export const confirmPrintedSchema = z.object({
  count: z.number().int().min(1).max(PRINT_LIMITS.printedMax),
});
export const handOverSchema = z.object({
  to: z.string().trim().min(1).max(PRINT_LIMITS.handedOverToMax),
});
export const coeditorSchema = z.object({ userId: id });

// ───────────── Views ─────────────

export const examGroupSchema = z.object({
  id: z.string(),
  /** Full name, parents first ("UFR SVT › Licence 3 Hydrologie"). */
  name: z.string(),
  organizationId: z.string(),
  organizationName: z.string(),
  /** Active secretariat members serving this group (itself or a parent). */
  secretariats: z.number().int(),
});
export type ExamGroup = z.infer<typeof examGroupSchema>;

export const printRequestViewSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  title: z.string(),
  status: z.enum(PRINT_STATUSES),
  organizationName: z.string(),
  groupId: z.string(),
  groupName: z.string(),
  teacherName: z.string(),
  pages: z.number().int(),
  copies: z.number().int(),
  reserveCopies: z.number().int(),
  duplex: z.enum(['SIMPLEX', 'DUPLEX']),
  stapled: z.boolean(),
  availableFrom: date,
  examAt: date,
  /** Still before its availability date: nobody can open it. */
  locked: z.boolean(),
  printedCount: z.number().int().nullable(),
  handedOverTo: z.string().nullable(),
  openedAt: date.nullable(),
  printedAt: date.nullable(),
  handedOverAt: date.nullable(),
  canceledAt: date.nullable(),
  replacedById: z.string().nullable(),
  createdAt: date,
  /** What the reader may do now. */
  can: z.object({
    modify: z.boolean(),
    cancel: z.boolean(),
    replace: z.boolean(),
    preview: z.boolean(),
    print: z.boolean(),
    confirmPrinted: z.boolean(),
    handOver: z.boolean(),
  }),
});
export type PrintRequestView = z.infer<typeof printRequestViewSchema>;

export const printEventViewSchema = z.object({
  id: z.string(),
  type: z.enum(PRINT_EVENT_TYPES),
  actorName: z.string().nullable(),
  /** The reader did it. */
  mine: z.boolean(),
  ip: z.string().nullable(),
  createdAt: date,
  requestId: z.string().nullable(),
  requestTitle: z.string().nullable(),
  /** Exam paper name (journal of a secretariat or of an organization). */
  projectName: z.string().nullable(),
  details: z.object({
    count: z.number().int().nullable(),
    to: z.string().nullable(),
    /** CANCELED: replaced by a new send. */
    replaced: z.boolean(),
    /** UPDATED: fields changed. */
    changes: z.array(z.string()),
    /** COEDITOR_*: the teacher added or removed. */
    userName: z.string().nullable(),
    /** OPENED: by the author (teacher, co-editor) rather than the secretariat. */
    byAuthor: z.boolean(),
  }),
});
export type PrintEventView = z.infer<typeof printEventViewSchema>;

export const printSendViewSchema = z.object({
  id: z.string(),
  status: z.enum(['COMPILING', 'FAILED', 'DONE']),
  /** FAILED by the compilation: its outcome and first issues (translated by the app). */
  outcome: z.enum(COMPILE_OUTCOMES).nullable(),
  issues: z.array(compileIssueSchema),
  /** FAILED for another reason: an API error code (the replaced request was opened meanwhile). */
  reason: z.string().nullable(),
  createdAt: date,
});
export type PrintSendView = z.infer<typeof printSendViewSchema>;

export const examPaperSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(['OWNER', 'EDITOR']),
  ownerName: z.string(),
  lastActivityAt: date,
  createdAt: date,
  /** The most recent request still running (not canceled), if any. */
  current: printRequestViewSchema.nullable(),
  sending: z.boolean(),
});
export type ExamPaperSummary = z.infer<typeof examPaperSummarySchema>;

export const examPaperListSchema = z.object({
  /** The user may create exam papers (active teacher of a live BUSINESS). */
  canCreate: z.boolean(),
  papers: z.array(examPaperSummarySchema),
});
export type ExamPaperList = z.infer<typeof examPaperListSchema>;

export const coeditorViewSchema = z.object({
  userId: z.string(),
  name: z.string(),
  organizationName: z.string(),
});
export type CoeditorView = z.infer<typeof coeditorViewSchema>;

export const examPaperDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(['OWNER', 'EDITOR']),
  ownerName: z.string(),
  /** Owner only: sends, changes and cancels requests, manages co-editors. */
  canSend: z.boolean(),
  groups: z.array(examGroupSchema),
  send: printSendViewSchema.nullable(),
  requests: z.array(printRequestViewSchema),
  coeditors: z.array(coeditorViewSchema),
  /** Teachers who can be added (owner only). */
  candidates: z.array(coeditorViewSchema),
});
export type ExamPaperDetail = z.infer<typeof examPaperDetailSchema>;

/** Signed link to a PDF of the files domain (preview with watermark, or one-time print file). */
export const printLinkSchema = z.object({ url: z.string(), expiresAt: date });
export type PrintLink = z.infer<typeof printLinkSchema>;

export const secretariatQueueSchema = z.object({
  organizationName: z.string(),
  /** Groups served ("UFR SVT"). */
  groups: z.array(z.string()),
  stats: z.object({
    toPrint: z.number().int(),
    examTomorrow: z.number().int(),
    scheduled: z.number().int(),
    printedThisWeek: z.number().int(),
    toHandOver: z.number().int(),
    copiesThisMonth: z.number().int(),
    requestsThisMonth: z.number().int(),
  }),
  requests: z.array(printRequestViewSchema),
});
export type SecretariatQueue = z.infer<typeof secretariatQueueSchema>;

export const printRequestPageSchema = z.object({
  request: printRequestViewSchema,
  events: z.array(printEventViewSchema),
});
export type PrintRequestPage = z.infer<typeof printRequestPageSchema>;

export const printJournalSchema = z.object({
  events: z.array(printEventViewSchema),
});
export type PrintJournal = z.infer<typeof printJournalSchema>;

/** Print requests of an organization for its owner and admins: metadata and journal, no PDF. */
export const orgPrintOverviewSchema = z.object({
  requests: z.array(printRequestViewSchema),
  events: z.array(printEventViewSchema),
});
export type OrgPrintOverview = z.infer<typeof orgPrintOverviewSchema>;

// ───────────── Official templates (BUSINESS) ─────────────

export const ORG_TEMPLATE_CATEGORY = 'official';
export const orgTemplateQuerySchema = z.object({
  name,
  description: z.string().trim().max(280).optional(),
});
export const updateOrgTemplateSchema = z
  .object({
    name: name.optional(),
    description: z.string().trim().max(280).nullable().optional(),
    published: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'empty' });

export const orgTemplateViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  published: z.boolean(),
  createdAt: date,
});
export type OrgTemplateView = z.infer<typeof orgTemplateViewSchema>;

export const orgTemplateListSchema = z.array(orgTemplateViewSchema);

export const printRequestListSchema = z.object({ requests: z.array(printRequestViewSchema) });
export type PrintRequestList = z.infer<typeof printRequestListSchema>;
