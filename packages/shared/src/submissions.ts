import { z } from 'zod';
import { compilationSchema } from './compile.js';
import { PATH_LIMITS, PROJECT_ROLES } from './projects.js';

// Submissions to supervisors (docs/spec.md, "Encadrement"): files chosen in a project, frozen and
// compiled at each sending (v1, v2…), reviewed, then validated by a supervisor (Encadrant).

/** Error codes of the submission endpoints. */
export const SUBMISSION_ERROR_CODES = [
  // The action is not allowed in the current status of the submission.
  'submission_state',
  // A sending of this submission is being compiled.
  'submission_busy',
  // A reviewer is not a supervisor or reviewer of the project.
  'reviewer_invalid',
  'no_reviewer',
  // A chosen file is not in the project (or the list is empty).
  'files_invalid',
  // The version shown is no longer the last one (a new version was sent meanwhile).
  'version_changed',
  // A validated file cannot be put back: a folder now stands at its path.
  'validation_conflict',
  // The account (project owner) sent SUBMISSION_COMPILES_PER_HOUR sendings this hour.
  'submission_compile_limit',
] as const;
export type SubmissionErrorCode = (typeof SUBMISSION_ERROR_CODES)[number];

export const SUBMISSION_TITLE_MAX = 120;
export const SUBMISSION_MESSAGE_MAX = 2000;
/** Files chosen in one submission at most. */
export const SUBMISSION_MAX_FILES = 200;
/** Reviewers of one submission at most (co-supervision). */
export const SUBMISSION_MAX_REVIEWERS = 10;
/** Sendings per project and per hour (docs/spec.md: abuse limit, never the compile quota). */
export const SUBMISSION_SENDS_PER_HOUR = 3;
/** Lines of context around each change in a comparison. */
export const DIFF_CONTEXT_LINES = 3;

export const SUBMISSION_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'IN_REVIEW',
  'FEEDBACK_SENT',
  'REVISED',
  'VALIDATED',
] as const;
export type SubmissionStatusValue = (typeof SUBMISSION_STATUSES)[number];

/** Statuses in which reviewers have something to read. */
export const TO_REVIEW_STATUSES = ['SUBMITTED', 'IN_REVIEW', 'REVISED'] as const;

/** Roles that can be chosen as reviewers; only supervisors validate. */
export const REVIEWER_ROLES = ['SUPERVISOR', 'REVIEWER'] as const;

/** Audit actions of a submission (AuditLog, target "Submission"), also shown as its thread. */
export const SUBMISSION_ACTIONS = [
  'SUBMISSION_SENT',
  'SUBMISSION_REVIEW_STARTED',
  'SUBMISSION_FEEDBACK_SENT',
  'SUBMISSION_VALIDATED',
  'SUBMISSION_UNLOCKED',
  'SUBMISSION_DUE_CHANGED',
] as const;
export type SubmissionAction = (typeof SUBMISSION_ACTIONS)[number];

// ───────────── Requests ─────────────

const id = z.string().min(1).max(64);
const path = z.string().min(1).max(PATH_LIMITS.maxLength);
const title = z
  .string()
  .trim()
  .max(SUBMISSION_TITLE_MAX)
  .transform((value) => value || null)
  .nullable();
const message = z
  .string()
  .trim()
  .max(SUBMISSION_MESSAGE_MAX)
  .transform((value) => value || null)
  .nullable();
/** A deadline within a sane range (an input error otherwise). */
const dueAt = z.iso
  .datetime()
  .refine((value) => {
    const year = new Date(value).getUTCFullYear();
    return year >= 2020 && year <= 2100;
  })
  .nullable();
const filePaths = z.array(path).max(SUBMISSION_MAX_FILES);
const reviewerIds = z.array(id).max(SUBMISSION_MAX_REVIEWERS);

/** A new draft: everything can still change until it is sent. */
export const createSubmissionSchema = z.object({
  title: title.default(null),
  filePaths: filePaths.default([]),
  message: message.default(null),
  dueAt: dueAt.default(null),
  reviewerIds: reviewerIds.default([]),
});
export type CreateSubmissionRequest = z.input<typeof createSubmissionSchema>;

/** Changes of a draft (only the fields given). */
export const updateSubmissionSchema = z.object({
  title: title.optional(),
  filePaths: filePaths.optional(),
  message: message.optional(),
  dueAt: dueAt.optional(),
  reviewerIds: reviewerIds.optional(),
});
export type UpdateSubmissionRequest = z.input<typeof updateSubmissionSchema>;

/** Sends the draft (v1) or a corrected version (after feedback). */
export const sendSubmissionSchema = z.object({
  filePaths: filePaths.min(1),
  message: message.default(null),
});
export type SendSubmissionRequest = z.input<typeof sendSubmissionSchema>;

/** Validates the version the supervisor read (refused when a newer one was sent). */
export const validateSubmissionSchema = z.object({ number: z.number().int().positive() });

export const submissionDueSchema = z.object({ dueAt });

export const compareQuerySchema = z.object({
  from: z.coerce.number().int().positive(),
  to: z.coerce.number().int().positive(),
});

// ───────────── Responses ─────────────

const date = z.iso.datetime();
const person = z.object({ id: z.string(), name: z.string() });

export const submissionFileHashSchema = z.object({ path: z.string(), sha256: z.string() });
export type SubmissionFileHash = z.infer<typeof submissionFileHashSchema>;

export const submissionVersionSchema = z.object({
  id: z.string(),
  /** 1, 2…; null while compiling and for a sending that produced no PDF. */
  number: z.number().int().positive().nullable(),
  state: z.enum(['COMPILING', 'READY', 'FAILED']),
  filePaths: z.array(z.string()),
  message: z.string().nullable(),
  files: z.array(submissionFileHashSchema),
  sentBy: person,
  createdAt: date,
  readyAt: date.nullable(),
  /** Compilation of the frozen version: its PDF (signed links), or its errors. */
  compilation: compilationSchema.nullable(),
});
export type SubmissionVersionInfo = z.infer<typeof submissionVersionSchema>;

export const submissionReviewerSchema = person.extend({
  /** Current role on the project; null once the access was removed. */
  role: z.enum(PROJECT_ROLES).nullable(),
  lastReviewedAt: date.nullable(),
});

export const submissionEventSchema = z.object({
  action: z.enum(SUBMISSION_ACTIONS),
  at: date,
  actor: person.nullable(),
  /** Version number (sent, validated), new deadline, files put back at validation. */
  number: z.number().int().nullable(),
  dueAt: date.nullable(),
  restored: z.array(z.string()),
  /** Version of the project saved before the validated files were put back. */
  beforeVersionId: z.string().nullable(),
  beforeVersionLabel: z.string().nullable(),
});
export type SubmissionEvent = z.infer<typeof submissionEventSchema>;

export const submissionSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string().nullable(),
  status: z.enum(SUBMISSION_STATUSES),
  dueAt: date.nullable(),
  author: person,
  reviewers: z.array(person),
  /** Number of the last version sent; null before the first one. */
  lastNumber: z.number().int().positive().nullable(),
  /** A sending is being compiled. */
  sending: z.boolean(),
  submittedAt: date.nullable(),
  /** Last version ready (what the reviewers received). */
  receivedAt: date.nullable(),
  updatedAt: date,
});
export type SubmissionSummary = z.infer<typeof submissionSummarySchema>;

export const submissionListSchema = z.object({
  submissions: z.array(submissionSummarySchema),
  /** Owner and editors create submissions (project not read-only). */
  canCreate: z.boolean(),
  /** Members who can be chosen as reviewers. */
  candidates: z.array(person.extend({ role: z.enum(REVIEWER_ROLES) })),
});
export type SubmissionList = z.infer<typeof submissionListSchema>;

export const submissionDetailSchema = submissionSummarySchema.extend({
  projectName: z.string(),
  /** Draft of the next sending (files and message). */
  filePaths: z.array(z.string()),
  message: z.string().nullable(),
  reviewerDetails: z.array(submissionReviewerSchema),
  /** Every sending, the newest first. */
  versions: z.array(submissionVersionSchema),
  validatedAt: date.nullable(),
  validatedBy: person.nullable(),
  validatedNumber: z.number().int().nullable(),
  unlockedAt: date.nullable(),
  unlockedBy: person.nullable(),
  /**
   * Files of the last version changed in the project since it was sent (shown to supervisors
   * before validating: they validate the version sent). Empty for the other roles.
   */
  changedSinceSent: z.array(z.string()),
  /** Thread: sendings, status changes, validation, unlocking, deadlines (oldest first). */
  events: z.array(submissionEventSchema),
  /** What the user may do now. */
  can: z.object({
    edit: z.boolean(),
    send: z.boolean(),
    delete: z.boolean(),
    feedback: z.boolean(),
    validate: z.boolean(),
    unlock: z.boolean(),
    setDue: z.boolean(),
  }),
  /** The user is one of the reviewers. */
  isReviewer: z.boolean(),
});
export type SubmissionDetail = z.infer<typeof submissionDetailSchema>;

export const toReviewItemSchema = submissionSummarySchema.extend({ projectName: z.string() });
export type ToReviewItem = z.infer<typeof toReviewItemSchema>;
export const toReviewListSchema = z.object({ submissions: z.array(toReviewItemSchema) });
export type ToReviewList = z.infer<typeof toReviewListSchema>;

// ───────────── Comparison ─────────────

export const diffSegmentSchema = z.object({ text: z.string(), changed: z.boolean() });
export type DiffSegment = z.infer<typeof diffSegmentSchema>;

export const diffLineSchema = z.object({
  type: z.enum(['same', 'added', 'removed']),
  text: z.string(),
  /** Line numbers in the older and the newer version. */
  from: z.number().int().positive().nullable(),
  to: z.number().int().positive().nullable(),
  /** A changed line paired with its counterpart: the text cut into changed and kept words. */
  segments: z.array(diffSegmentSchema).optional(),
});
export type DiffLine = z.infer<typeof diffLineSchema>;

export const diffHunkSchema = z.object({ lines: z.array(diffLineSchema) });
export type DiffHunk = z.infer<typeof diffHunkSchema>;

export const fileComparisonSchema = z.object({
  path: z.string(),
  kind: z.enum(['TEXT', 'BINARY']),
  change: z.enum(['same', 'modified', 'added', 'removed']),
  /** Changed lines with context (text files); empty when `tooLarge`. */
  hunks: z.array(diffHunkSchema),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  /** Too many lines or changes to show the difference line by line. */
  tooLarge: z.boolean(),
});
export type FileComparison = z.infer<typeof fileComparisonSchema>;

export const submissionComparisonSchema = z.object({
  from: z.number().int().positive(),
  to: z.number().int().positive(),
  files: z.array(fileComparisonSchema),
});
export type SubmissionComparison = z.infer<typeof submissionComparisonSchema>;
