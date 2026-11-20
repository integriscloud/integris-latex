import { z } from 'zod';
import { dialCodeOf } from './auth.js';
import { PROJECT_ROLES, type ProjectRoleValue } from './projects.js';

// Sharing, public links and comments (docs/spec.md, "Projets, partage et encadrement").

/** Error codes of the sharing, invitation, public link and comment endpoints. */
export const SHARING_ERROR_CODES = [
  'collaborator_limit',
  // The Editor role on a project read-only beyond the plan's limits.
  'read_only_editor',
  'already_member',
  'already_invited',
  'cannot_invite_self',
  'invalid_contact',
  'invitation_invalid',
  'invitation_other_account',
  'link_exists',
  'link_invalid',
  'suggestion_decided',
  'file_missing',
] as const;
export type SharingErrorCode = (typeof SHARING_ERROR_CODES)[number];

// ───────────── Roles and invitations ─────────────

/** Roles the owner gives (the owner role is never given). */
export const SHAREABLE_ROLES = ['EDITOR', 'SUPERVISOR', 'REVIEWER', 'VIEWER'] as const;
export type ShareableRole = (typeof SHAREABLE_ROLES)[number];

/** An invitation can be accepted for this long. */
export const INVITATION_TTL_DAYS = 14;

/** Optional message of an invitation: in the e-mail and on the invitation page, never in the SMS. */
export const SHARE_MESSAGE_MAX = 280;

/**
 * Whether a role counts against "Collaborateurs par projet" of the owner's plan. The owner is not
 * a member; supervisors (Encadrant) never count: submitting to a supervisor is allowed on every
 * plan, Gratuit included.
 */
export const countsAsCollaborator = (role: ProjectRoleValue) =>
  role !== 'OWNER' && role !== 'SUPERVISOR';

/** Tokens of invitations and public links: 32 bytes in base64url. */
export const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

const role = z.enum(SHAREABLE_ROLES);
const message = z
  .string()
  .trim()
  .max(SHARE_MESSAGE_MAX)
  .transform((value) => value || undefined)
  .optional();

/** Invitation by phone number (with the dial code chosen in the form) or by e-mail address. */
export const inviteSchema = z.discriminatedUnion('channel', [
  z.object({
    channel: z.literal('phone'),
    phone: z.string().trim().min(4).max(32),
    dialCode: z.string().regex(/^\d{1,4}$/),
    role,
    message,
  }),
  z.object({
    channel: z.literal('email'),
    email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
    role,
    message,
  }),
]);
export type InviteRequest = z.input<typeof inviteSchema>;

export const changeRoleSchema = z.object({ role });

const date = z.iso.datetime();

export const projectMemberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  role: z.enum(PROJECT_ROLES),
  /** Counts against the collaborator limit of the plan. */
  counted: z.boolean(),
});
export type ProjectMemberInfo = z.infer<typeof projectMemberSchema>;

export const pendingInvitationSchema = z.object({
  id: z.string(),
  channel: z.enum(['phone', 'email']),
  /** Phone or e-mail address as typed by the owner (only the owner sees invitations). */
  contact: z.string(),
  role,
  message: z.string().nullable(),
  createdAt: date,
  expiresAt: date,
  counted: z.boolean(),
});
export type PendingInvitation = z.infer<typeof pendingInvitationSchema>;

export const shareLinkSchema = z.object({
  id: z.string(),
  url: z.string(),
  includeSources: z.boolean(),
  expiresAt: date.nullable(),
  createdAt: date,
});
export type ShareLinkInfo = z.infer<typeof shareLinkSchema>;

/** Sharing panel of a project. Invitations and links are given to the owner only. */
export const projectSharingSchema = z.object({
  owner: z.object({ userId: z.string(), name: z.string() }),
  members: z.array(projectMemberSchema),
  invitations: z.array(pendingInvitationSchema),
  /** The active public link (one at most). */
  link: shareLinkSchema.nullable(),
  /** Collaborators counted (members and pending invitations) and the plan limit (null: none). */
  collaborators: z.object({ used: z.number().int(), max: z.number().int().nullable() }),
  canShare: z.boolean(),
  /** Read-only beyond the plan's limits: shared for reading only (no Editor role). */
  readOnly: z.boolean(),
});
export type ProjectSharing = z.infer<typeof projectSharingSchema>;

/** Invitation page (read with the token, without being signed in). */
export const invitationViewSchema = z.object({
  projectName: z.string(),
  inviterName: z.string(),
  role,
  message: z.string().nullable(),
  channel: z.enum(['phone', 'email']),
  /** Masked phone number or e-mail address the invitation was sent to. */
  contactHint: z.string(),
  status: z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'REVOKED']),
  expiresAt: date,
});
export type InvitationView = z.infer<typeof invitationViewSchema>;

export const acceptedInvitationSchema = z.object({ projectId: z.string() });

// ───────────── Public links ─────────────

export const createShareLinkSchema = z.object({
  /** "Inclure les fichiers source (lecture seule)", unchecked by default. */
  includeSources: z.boolean().default(false),
  /** Optional expiry, in the future. */
  expiresAt: date.nullable().default(null),
});
export type CreateShareLinkRequest = z.input<typeof createShareLinkSchema>;

/** What a public link shows: the last successful PDF, and the sources when included. */
export const publicProjectSchema = z.object({
  name: z.string(),
  pdf: z.object({ url: z.string(), downloadUrl: z.string() }).nullable(),
  /** Null when the link does not include the sources. */
  files: z
    .array(
      z.object({
        id: z.string(),
        path: z.string(),
        kind: z.enum(['TEXT', 'BINARY']),
        sizeBytes: z.number().int().nonnegative(),
      }),
    )
    .nullable(),
});
export type PublicProject = z.infer<typeof publicProjectSchema>;

// ───────────── Comments ─────────────

export const COMMENT_LIMITS = { body: 4000, quoted: 2000, suggestion: 10_000 } as const;

/** Yjs relative position (Y.relativePositionToJSON): follows the text as it changes around. */
export const relativePositionSchema = z
  .object({
    type: z.object({ client: z.number().int(), clock: z.number().int() }).nullish(),
    tname: z.string().max(64).nullish(),
    item: z.object({ client: z.number().int(), clock: z.number().int() }).nullish(),
    assoc: z.number().int().optional(),
  })
  .strict();
export type RelativePositionJson = z.infer<typeof relativePositionSchema>;

/** Selection a comment is anchored to, in the shared text of its file. */
export const commentAnchorSchema = z.object({
  start: relativePositionSchema,
  end: relativePositionSchema,
});
export type CommentAnchor = z.infer<typeof commentAnchorSchema>;

const body = z.string().trim().min(1).max(COMMENT_LIMITS.body);

export const createCommentSchema = z.object({
  fileId: z.string().min(1).max(64),
  anchor: commentAnchorSchema,
  quotedText: z.string().min(1).max(COMMENT_LIMITS.quoted),
  body,
  /** Replacement proposal; an empty text proposes to delete the selection. */
  suggestedText: z.string().max(COMMENT_LIMITS.suggestion).optional(),
});
export type CreateCommentRequest = z.infer<typeof createCommentSchema>;

export const replySchema = z.object({ body });

export const resolveCommentSchema = z.object({ resolved: z.boolean() });

export const decideSuggestionSchema = z.discriminatedUnion('decision', [
  // Applied in the shared text by the editor first; the anchor then covers the new text.
  z.object({ decision: z.literal('APPLIED'), anchor: commentAnchorSchema }),
  z.object({ decision: z.literal('REJECTED') }),
]);
export type DecideSuggestionRequest = z.infer<typeof decideSuggestionSchema>;

const person = z.object({ id: z.string(), name: z.string() });

export const commentSchema = z.object({
  id: z.string(),
  /** Null when the file was deleted. */
  fileId: z.string().nullable(),
  anchor: commentAnchorSchema,
  quotedText: z.string(),
  body: z.string(),
  author: person,
  createdAt: date,
  suggestedText: z.string().nullable(),
  suggestionStatus: z.enum(['PENDING', 'APPLIED', 'REJECTED']).nullable(),
  suggestionDecidedBy: person.nullable(),
  status: z.enum(['OPEN', 'RESOLVED']),
  resolvedAt: date.nullable(),
  resolvedBy: person.nullable(),
  replies: z.array(z.object({ id: z.string(), author: person, body: z.string(), createdAt: date })),
  /** Whether the user may resolve or reopen it (author, owner, editor). */
  canResolve: z.boolean(),
});
export type CommentInfo = z.infer<typeof commentSchema>;

export const commentListSchema = z.object({ comments: z.array(commentSchema) });
export type CommentList = z.infer<typeof commentListSchema>;

// ───────────── Helpers ─────────────

/** Masked contact shown on the invitation page: "+226 •• •• •• 12", "a•••@example.org". */
export function maskContact(contact: string): string {
  const at = contact.indexOf('@');
  if (at > 0) return `${contact[0]}•••${contact.slice(at)}`;
  const country = dialCodeOf(contact) ?? '';
  return `+${country} •• •• •• ${contact.slice(-2)}`;
}
