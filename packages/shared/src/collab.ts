import { z } from 'zod';

// ───────────── Documents ─────────────

/** Ids of projects and files (cuid; UUID in tests): never a `:`. */
const ID = /^[a-z0-9-]{8,40}$/;

/** Name of the Yjs document holding a text file. */
export const fileDocumentName = (projectId: string, fileId: string) =>
  `file:${projectId}:${fileId}`;

/** Name of the document of a project used for presence only (who is online, in which file). */
export const presenceDocumentName = (projectId: string) => `presence:${projectId}`;

export type CollabDocument =
  { kind: 'file'; projectId: string; fileId: string } | { kind: 'presence'; projectId: string };

/** Parses a document name sent by a client; null when it is not one of ours. */
export function parseDocumentName(name: string): CollabDocument | null {
  if (name.length > 100) return null;
  const parts = name.split(':');
  if (parts[0] === 'file' && parts.length === 3 && ID.test(parts[1]!) && ID.test(parts[2]!)) {
    return { kind: 'file', projectId: parts[1]!, fileId: parts[2]! };
  }
  if (parts[0] === 'presence' && parts.length === 2 && ID.test(parts[1]!)) {
    return { kind: 'presence', projectId: parts[1]! };
  }
  return null;
}

/**
 * Largest Yjs state of a file document (encoded): twice the 10 MB of a file, for the history of
 * edits the state carries. Above it the document takes no more changes.
 */
export const MAX_DOCUMENT_STATE_BYTES = 20 * 1024 * 1024;

/** Y.Text holding the content of a file in its document. */
export const FILE_TEXT_NAME = 'content';

/** Colors of the people in a project: the `--presence-N` tokens. */
export const PRESENCE_COLORS = 6;

/** Presence color of a user, the same in every document and on every device. */
export function presenceColorOf(userId: string): number {
  let hash = 0;
  for (let index = 0; index < userId.length; index++) {
    hash = (hash * 31 + userId.charCodeAt(index)) >>> 0;
  }
  return (hash % PRESENCE_COLORS) + 1;
}

/** A person in a project, as the API identifies them for the collaboration server. */
export const collabUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Index of the `--presence-N` token. */
  color: z.number().int().min(1).max(PRESENCE_COLORS),
  /** Whether this person can write (owner or editor). */
  editor: z.boolean(),
});
export type CollabUser = z.infer<typeof collabUserSchema>;

/**
 * `user` field of an awareness state, read by the editor and by y-codemirror (`color`,
 * `colorLight`). The collaboration server always overwrites it from the session: nothing a client
 * sends there is trusted, and the colors are only ever these token references.
 */
export const awarenessUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  editor: z.boolean(),
  colorIndex: z.number().int().min(1).max(PRESENCE_COLORS),
  color: z.string().regex(/^var\(--presence-[1-6]\)$/),
  colorLight: z.string().regex(/^var\(--presence-[1-6]-selection\)$/),
});
export type AwarenessUser = z.infer<typeof awarenessUserSchema>;

export function awarenessUserOf(user: CollabUser): AwarenessUser {
  return {
    id: user.id,
    name: user.name,
    editor: user.editor,
    colorIndex: user.color,
    color: `var(--presence-${user.color})`,
    colorLight: `var(--presence-${user.color}-selection)`,
  };
}

// ───────────── Messages between the editor and the collaboration server ─────────────

/** Why the text of a file could not be written to storage. */
export const STORE_BLOCK_CODES = [
  'storage_limit',
  'file_too_large',
  'read_only',
  'file_locked',
  'not_found',
  'unavailable',
] as const;
export type StoreBlockCode = (typeof STORE_BLOCK_CODES)[number];

/** Stateless messages sent by the editor. */
export const collabClientMessageSchema = z.object({
  // Writes the text to storage now (before a compilation or a named version).
  type: z.literal('flush'),
  id: z.number().int().nonnegative(),
});
export type CollabClientMessage = z.infer<typeof collabClientMessageSchema>;

/** Stateless messages sent by the collaboration server. */
export const collabServerMessageSchema = z.discriminatedUnion('type', [
  // Answer to a flush.
  z.object({
    type: z.literal('flushed'),
    id: z.number().int().nonnegative(),
    code: z.enum(STORE_BLOCK_CODES).nullable(),
  }),
  // Outcome of the last write to storage, sent to everyone on the document when it changes.
  z.object({ type: z.literal('stored'), code: z.enum(STORE_BLOCK_CODES).nullable() }),
  // On the presence document: the comments of the project changed (read them again).
  z.object({ type: z.literal('comments') }),
  // On the presence document: rights on the project changed (read the project again).
  z.object({ type: z.literal('access') }),
  // On the presence document: files or folders were created, moved or deleted (read the
  // project again).
  z.object({ type: z.literal('files') }),
]);
export type CollabServerMessage = z.infer<typeof collabServerMessageSchema>;

/** WebSocket close reasons the editor explains to the user. */
export const COLLAB_CLOSE = {
  // The session ended, or the right on the project or the file was lost.
  revoked: { code: 4403, reason: 'revoked' },
  // The file was deleted.
  deleted: { code: 4404, reason: 'deleted' },
  // The file was locked by a validated submission: the editor drops the changes it has not
  // stored and opens the file again (validated text, read-only).
  locked: { code: 4423, reason: 'locked' },
} as const;

// ───────────── Events from the API to the collaboration server (Redis) ─────────────

export const COLLAB_EVENTS_CHANNEL = 'collab:events';

export const collabEventSchema = z.discriminatedUnion('type', [
  // Content replaced outside the editor (upload, restoration): applied as a diff.
  z.object({ type: z.literal('file-replaced'), projectId: z.string(), fileId: z.string() }),
  z.object({ type: z.literal('file-deleted'), projectId: z.string(), fileId: z.string() }),
  // Locked by a validation: the document takes the validated text and its editors start again.
  z.object({ type: z.literal('file-locked'), projectId: z.string(), fileId: z.string() }),
  // Rights, read-only state or trash changed: every connection of the project is checked again.
  z.object({ type: z.literal('project-access'), projectId: z.string() }),
  // A comment was added, answered, resolved or decided: the open editors read them again.
  z.object({ type: z.literal('comments-changed'), projectId: z.string() }),
  // Files or folders were created, moved or deleted: the open editors read the project again.
  z.object({ type: z.literal('files-changed'), projectId: z.string() }),
]);
export type CollabEvent = z.infer<typeof collabEventSchema>;

// ───────────── Internal API (collaboration server → API, loopback only) ─────────────

/** Header carrying COLLAB_INTERNAL_SECRET on internal requests. */
export const COLLAB_SECRET_HEADER = 'x-integris-collab-secret';

export const INTERNAL_PATHS = {
  authorize: '/internal/collab/authorize',
  load: '/internal/collab/load',
  store: '/internal/collab/store',
  /** Development only (pnpm dev:plan): the plans of these users changed, apply their limits. */
  planChanged: '/internal/plans/changed',
} as const;

export const planChangedRequestSchema = z.object({
  userIds: z.array(z.string().min(1).max(64)).min(1).max(1000),
});

export const authorizeRequestSchema = z.object({
  /** Value of the session cookie sent with the WebSocket upgrade. */
  session: z.string().max(128),
  projectId: z.string().regex(ID),
  /** Null for the presence document of the project. */
  fileId: z.string().regex(ID).nullable(),
  /** Periodic check of an open connection: it must not extend the session (idle timeout). */
  recheck: z.boolean().default(false),
});
export type AuthorizeRequest = z.infer<typeof authorizeRequestSchema>;

export const authorizeResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    user: collabUserSchema,
    /** Whether this connection may change the document (checked again by the API on store). */
    writable: z.boolean(),
  }),
  z.object({ ok: z.literal(false) }),
]);
export type AuthorizeResponse = z.infer<typeof authorizeResponseSchema>;

export const loadRequestSchema = z.object({
  projectId: z.string().regex(ID),
  fileId: z.string().regex(ID),
});

export const loadResponseSchema = z.object({
  /** Stored Yjs state (base64), or null for a file never opened in the editor. */
  state: z.string().nullable(),
  /**
   * Text of the file in storage when the state does not hold it (first opening, or content
   * replaced outside the editor): the collaboration server applies it as a diff.
   */
  text: z.string().nullable(),
  /** Storage key of the text the document now holds: sent back as `baseKey` on store. */
  key: z.string().nullable(),
});
export type LoadResponse = z.infer<typeof loadResponseSchema>;

export const storeRequestSchema = z.object({
  projectId: z.string().regex(ID),
  fileId: z.string().regex(ID),
  // base64 of at most MAX_DOCUMENT_STATE_BYTES; a text over 10 MB is answered `file_too_large`.
  state: z.string().max(Math.ceil(MAX_DOCUMENT_STATE_BYTES / 3) * 4),
  text: z.string().max(2 * 10 * 1024 * 1024),
  /** Storage key of the last text loaded or stored by this document. */
  baseKey: z.string().nullable(),
});
export type StoreRequest = z.infer<typeof storeRequestSchema>;

export const storeResponseSchema = z.object({
  code: z.enum(STORE_BLOCK_CODES).nullable(),
  /**
   * Text replaced outside the editor since `baseKey` (upload, restoration): nothing was written;
   * the collaboration server applies it as a diff, then stores again.
   */
  text: z.string().nullable(),
  /** Storage key now holding the text (the new `baseKey`). */
  key: z.string().nullable(),
});
export type StoreResponse = z.infer<typeof storeResponseSchema>;
