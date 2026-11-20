import type { IncomingMessage } from 'node:http';
import { type Connection, type Document, Server } from '@hocuspocus/server';
import {
  type AwarenessUser,
  awarenessUserOf,
  COLLAB_CLOSE,
  COLLAB_PATH,
  type CollabEvent,
  collabClientMessageSchema,
  type CollabServerMessage,
  FILE_TEXT_NAME,
  fileDocumentName,
  MAX_DOCUMENT_STATE_BYTES,
  parseDocumentName,
  presenceDocumentName,
  SESSION_COOKIE,
  type StoreBlockCode,
} from '@integris/shared';
import type { Logger } from 'pino';
import * as Y from 'yjs';
import { z } from 'zod';
import { type CollabApi, InternalApiError } from './api-client.js';
import { applyText, mergeText } from './text-diff.js';

export const HEALTH_PATH = `${COLLAB_PATH}/health`;

// Changes applied by the server itself: loading (never stored back) and outside replacements.
const LOAD_ORIGIN = { source: 'local', skipStoreHooks: true } as const;
const MERGE_ORIGIN = { source: 'local', skipStoreHooks: true } as const;
const REPLACE_ORIGIN = { source: 'local' } as const;
// A store that could not reach the API is tried again this much later.
const RETRY_MS = 30_000;
// A flush per connection at most this often (each one may send the whole state to the API).
const FLUSH_INTERVAL_MS = 2_000;
// Per socket: refused authentications, then documents opened, before the socket gets no answer
// from the API any more (each authentication costs the API a session read and queries).
const MAX_REFUSALS = 5;
const MAX_DOCUMENTS = 200;
// Yjs sync messages carrying changes (step 2 and update), checked against the size cap.
const CHANGE_MESSAGES = new Set([1, 2]);
// Session cookie: 32 random bytes in base64url.
const SESSION_FORMAT = /^[A-Za-z0-9_-]{20,128}$/;

/** Relative position of y-codemirror (Y.relativePositionToJSON). */
const position = z
  .object({
    type: z.object({ client: z.number().int(), clock: z.number().int() }).nullish(),
    tname: z.string().max(64).nullish(),
    item: z.object({ client: z.number().int(), clock: z.number().int() }).nullish(),
    assoc: z.number().int().optional(),
  })
  .strict();

/** Awareness fields a client may set; `user` is always overwritten by the server. */
const awarenessFields = z.object({
  cursor: z.object({ anchor: position, head: position }).strict().nullish(),
  fileId: z
    .string()
    .regex(/^[a-z0-9-]{8,40}$/)
    .nullish(),
});

/** Set by onAuthenticate on every connection (one per document of a socket). */
export interface CollabContext {
  user: AwarenessUser;
  writable: boolean;
  session: string;
  projectId: string;
  fileId: string | null;
  /** Yjs client ids of this connection's awareness: it may only speak for these. */
  clientIds: Set<number>;
  socketId: string;
  lastFlush: number;
}

/** Store status of a file document. */
interface DocState {
  projectId: string;
  fileId: string;
  /** Storage key of the text last loaded or stored. */
  baseKey: string | null;
  /** State whose text is the one at `baseKey`: base of the merges of outside replacements. */
  baseState: Uint8Array;
  /** Changed since the last successful store. */
  dirty: boolean;
  code: StoreBlockCode | null;
  retry?: NodeJS.Timeout;
  /** Encoded size of the state, about (changes since the last store are added up). */
  size: number;
}

function pathnameOf(request: IncomingMessage): string {
  return new URL(request.url ?? '/', 'http://localhost').pathname;
}

/** Value of one cookie in a Cookie header. */
export function cookieValue(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

class Refused extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export interface CollabServerOptions {
  port: number;
  logger: Logger;
  api: CollabApi;
  /** Browser origins allowed to open a WebSocket. */
  webOrigins: readonly string[];
  /** Every connection is checked again this often. */
  recheckMs: number;
  /** Store debounce (Hocuspocus defaults: 2 s after the last change, 10 s at most). */
  debounceMs?: number;
  maxDebounceMs?: number;
  /** Largest state of a document (tests use a small one). */
  maxStateBytes?: number;
}

export interface CollabServer {
  server: Server;
  /** Applies an event published by the API. */
  handleEvent(event: CollabEvent): Promise<void>;
  /** Checks every connection again (also run on a timer). */
  recheck(filter?: (context: CollabContext) => boolean): Promise<void>;
  destroy(): Promise<void>;
}

/**
 * Collaboration server (Hocuspocus). Every WebSocket connection is checked by the API: origin,
 * session, role on the project, state of the project and of the file. Only owners and editors
 * write; for every other role the server refuses changes, whatever the client does. Documents
 * are loaded and stored through the API, which applies the file and quota rules.
 */
export function createCollabServer(options: CollabServerOptions): CollabServer {
  const { logger, api } = options;
  const docs = new Map<string, DocState>();
  /** Per document, which socket holds each awareness client id (no squatting of another's). */
  const clientOwners = new Map<string, Map<number, string>>();
  /** Authentications per socket (see MAX_REFUSALS and MAX_DOCUMENTS). */
  const sockets = new Map<string, { refused: number; opened: number; seen: number }>();

  const allowedOrigin = (origin: string | null | undefined) =>
    typeof origin === 'string' && options.webOrigins.includes(origin);

  const textOf = (document: Y.Doc) => document.getText(FILE_TEXT_NAME);

  const send = (target: Connection | Document, message: CollabServerMessage) => {
    const payload = JSON.stringify(message);
    if ('sendStateless' in target) target.sendStateless(payload);
    else target.broadcastStateless(payload);
  };

  /** Stores a file document through the API, merging any text replaced outside meanwhile. */
  async function store(document: Document): Promise<StoreBlockCode | null> {
    const state = docs.get(document.name);
    if (!state) return null;
    clearTimeout(state.retry);
    const previous = state.code;
    state.dirty = false;
    let code: StoreBlockCode | null = 'unavailable';
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const sent = Y.encodeStateAsUpdate(document);
        const result = await api.store({
          projectId: state.projectId,
          fileId: state.fileId,
          state: Buffer.from(sent).toString('base64'),
          text: textOf(document).toString(),
          baseKey: state.baseKey,
        });
        code = result.code;
        if (result.text === null) {
          if (result.key !== state.baseKey) state.baseState = sent;
          state.baseKey = result.key;
          break;
        }
        state.baseState = mergeText(document, state.baseState, result.text, MERGE_ORIGIN);
        state.baseKey = result.key;
        code = 'unavailable';
      }
      state.size = Y.encodeStateAsUpdate(document).length;
    } catch (error) {
      // Refused by the internal API (over its size limits): blocked like a file over 10 MB.
      if (error instanceof InternalApiError && error.status >= 400 && error.status < 500) {
        code = 'file_too_large';
      }
      logger.warn({ err: error, fileId: state.fileId }, 'Document not stored');
    }
    state.code = code;
    // Only a failure is tried again; a block (quota, size, lock) waits for the next change.
    if (code === 'unavailable') state.dirty = true;
    // Kept changes are sent again later; the blocks (quota, size) wait for the next change.
    if (code === 'unavailable') {
      state.retry = setTimeout(() => void flush(document), RETRY_MS);
      state.retry.unref();
    }
    if (code !== previous) send(document, { type: 'stored', code });
    return code;
  }

  /** Stores now if something changed, and gives the outcome. */
  async function flush(document: Document): Promise<StoreBlockCode | null> {
    const state = docs.get(document.name);
    if (!state) return null;
    if (state.dirty) {
      await server.hocuspocus.storeDocumentHooks(
        document,
        {
          instance: server.hocuspocus,
          clientsCount: document.getConnectionsCount(),
          document,
          documentName: document.name,
          lastContext: {},
          lastTransactionOrigin: REPLACE_ORIGIN,
        },
        true,
      );
    }
    return docs.get(document.name)?.code ?? null;
  }

  async function authorize(
    context: Pick<CollabContext, 'session' | 'projectId' | 'fileId'>,
    recheck = false,
  ) {
    return api.authorize({
      session: context.session,
      projectId: context.projectId,
      fileId: context.fileId,
      recheck,
    });
  }

  const server = new Server({
    name: 'integris-collab',
    port: options.port,
    // Nginx on the same host is the only public entry point.
    address: '127.0.0.1',
    quiet: true,
    // Handled in main.ts so that shutdown is logged.
    stopOnSignals: false,
    debounce: options.debounceMs ?? 2_000,
    maxDebounce: options.maxDebounceMs ?? 10_000,
    // Applies before authentication: bound what a single connection can make us buffer.
    websocketOptions: { maxPayload: 1024 * 1024 },

    async onUpgrade({ request, socket }) {
      const refuse = (status: string) => {
        socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
        // An empty rejection stops Hocuspocus without crashing the server.
        return Promise.reject();
      };
      if (pathnameOf(request) !== COLLAB_PATH) return refuse('404 Not Found');
      // Another site cannot open a socket with the user's cookie (cross-site WebSocket hijacking).
      if (!allowedOrigin(request.headers.origin)) return refuse('403 Forbidden');
    },

    async onRequest({ request, response }) {
      const healthy = request.method === 'GET' && pathnameOf(request) === HEALTH_PATH;
      response.writeHead(healthy ? 200 : 404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(healthy ? { status: 'ok' } : { error: 'Not Found' }));
      return Promise.reject();
    },

    async onAuthenticate({ documentName, requestHeaders, connectionConfig, socketId }) {
      const target = parseDocumentName(documentName);
      const session = cookieValue(requestHeaders.get('cookie'), SESSION_COOKIE);
      const counts = sockets.get(socketId) ?? { refused: 0, opened: 0, seen: Date.now() };
      sockets.set(socketId, counts);
      counts.seen = Date.now();
      if (
        !target ||
        !session ||
        !SESSION_FORMAT.test(session) ||
        !allowedOrigin(requestHeaders.get('origin')) ||
        counts.refused >= MAX_REFUSALS ||
        counts.opened >= MAX_DOCUMENTS
      ) {
        counts.refused++;
        // The document name is client-controlled (up to maxPayload): never log it whole.
        logger.debug({ documentName: documentName.slice(0, 128) }, 'collab connection refused');
        throw new Refused('forbidden');
      }
      const context = {
        session,
        projectId: target.projectId,
        fileId: target.kind === 'file' ? target.fileId : null,
      };
      const answer = await authorize(context);
      if (!answer.ok) {
        counts.refused++;
        throw new Refused('forbidden');
      }
      counts.opened++;
      // Read-only on the server: Hocuspocus refuses every change from this connection.
      connectionConfig.readOnly = !answer.writable;
      return {
        ...context,
        user: awarenessUserOf(answer.user),
        writable: answer.writable,
        clientIds: new Set<number>(),
        socketId,
        lastFlush: 0,
      } satisfies CollabContext;
    },

    // A document never grows past MAX_DOCUMENT_STATE_BYTES: the change is refused and the
    // connection closed (memory of the server, size of what is stored).
    async beforeSync({ document, payload, type }) {
      const state = docs.get(document.name);
      if (!state || !CHANGE_MESSAGES.has(type)) return;
      if (state.size + payload.length > (options.maxStateBytes ?? MAX_DOCUMENT_STATE_BYTES)) {
        logger.warn({ fileId: state.fileId }, 'document too large: change refused');
        throw new Refused('too-large');
      }
    },

    async onDisconnect({ documentName, context }) {
      const own = context as CollabContext | undefined;
      const owners = clientOwners.get(documentName);
      if (!own || !owners) return;
      for (const clientId of own.clientIds) {
        if (owners.get(clientId) === own.socketId) owners.delete(clientId);
      }
      if (!owners.size) clientOwners.delete(documentName);
    },

    async onLoadDocument({ document, documentName }) {
      const target = parseDocumentName(documentName);
      // Presence documents hold no content.
      if (target?.kind !== 'file') return document;
      const loaded = await api.load(target.projectId, target.fileId);
      if (loaded.state) {
        Y.applyUpdate(document, Buffer.from(loaded.state, 'base64'), LOAD_ORIGIN);
      }
      if (loaded.text !== null) applyText(textOf(document), loaded.text, LOAD_ORIGIN);
      docs.set(documentName, {
        projectId: target.projectId,
        fileId: target.fileId,
        baseKey: loaded.key,
        baseState: Y.encodeStateAsUpdate(document),
        // Content replaced outside the editor: the merged state is stored at once.
        dirty: loaded.text !== null && loaded.state !== null,
        code: null,
        size: Y.encodeStateAsUpdate(document).length,
      });
      return document;
    },

    async onChange({ documentName, transactionOrigin, update }) {
      const state = docs.get(documentName);
      if (state) state.size += update.length;
      // Changes made while loading or merging are part of what is being stored.
      if (state && transactionOrigin !== LOAD_ORIGIN && transactionOrigin !== MERGE_ORIGIN) {
        state.dirty = true;
      }
    },

    async onStoreDocument({ document, documentName }) {
      if (!docs.get(documentName)?.dirty) return;
      await store(document);
    },

    async afterUnloadDocument({ documentName }) {
      clearTimeout(docs.get(documentName)?.retry);
      docs.delete(documentName);
    },

    async onStateless({ connection, document, payload }) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return;
      }
      const message = collabClientMessageSchema.safeParse(parsed);
      const state = docs.get(document.name);
      if (!message.success || !state) return;
      // Only writers store, at most every FLUSH_INTERVAL_MS per connection (a flush asked
      // sooner waits); the others get the current outcome.
      const context = connection.context as CollabContext;
      if (!context.writable) {
        send(connection, { type: 'flushed', id: message.data.id, code: state.code });
        return;
      }
      const wait = context.lastFlush + FLUSH_INTERVAL_MS - Date.now();
      // A burst of flushes is not queued without end.
      if (wait > 5 * FLUSH_INTERVAL_MS) {
        send(connection, { type: 'flushed', id: message.data.id, code: state.code });
        return;
      }
      context.lastFlush = Math.max(Date.now(), context.lastFlush + FLUSH_INTERVAL_MS);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      const code = await flush(document);
      send(connection, { type: 'flushed', id: message.data.id, code });
    },

    async beforeHandleAwareness({ context, states, removedClients, documentName }) {
      const own = context as CollabContext | undefined;
      if (!own) return;
      const owners = clientOwners.get(documentName) ?? new Map<number, string>();
      clientOwners.set(documentName, owners);
      for (const [clientId, state] of states) {
        // A connection speaks for one awareness client, bound on its first update, and never
        // for a client id another connection holds.
        if (own.clientIds.size === 0 && !owners.has(clientId)) {
          own.clientIds.add(clientId);
          owners.set(clientId, own.socketId);
        }
        if (!own.clientIds.has(clientId)) {
          states.delete(clientId);
          continue;
        }
        const fields = awarenessFields.safeParse(state);
        const clean: Record<string, unknown> = { user: own.user };
        if (fields.success) {
          if (fields.data.cursor !== undefined) clean.cursor = fields.data.cursor;
          if (fields.data.fileId !== undefined) clean.fileId = fields.data.fileId;
        }
        states.set(clientId, clean);
      }
      for (const clientId of removedClients) {
        if (!own.clientIds.has(clientId)) removedClients.delete(clientId);
      }
    },
  });

  async function recheck(filter: (context: CollabContext) => boolean = () => true) {
    const answers = new Map<string, Promise<Awaited<ReturnType<typeof authorize>> | null>>();
    for (const document of server.hocuspocus.documents.values()) {
      for (const connection of document.getConnections()) {
        const context = connection.context as CollabContext;
        if (!filter(context)) continue;
        const key = `${context.session}\n${context.projectId}\n${context.fileId ?? ''}`;
        if (!answers.has(key)) {
          // An API failure keeps the connection as it is until the next check.
          answers.set(
            key,
            authorize(context, true).catch((error: unknown) => {
              logger.warn({ err: error }, 'Connection check failed');
              return null;
            }),
          );
        }
        const answer = await answers.get(key)!;
        if (!answer) continue;
        if (!answer.ok) {
          connection.close(COLLAB_CLOSE.revoked);
          continue;
        }
        context.writable = answer.writable;
        context.user = awarenessUserOf(answer.user);
        connection.readOnly = !answer.writable;
      }
    }
  }

  /** Tells the editors open on a project (through its presence document) what changed. */
  function notifyProject(projectId: string, message: CollabServerMessage) {
    const presence = server.hocuspocus.documents.get(presenceDocumentName(projectId));
    if (presence) send(presence, message);
  }

  async function handleEvent(event: CollabEvent) {
    if (event.type === 'project-access') {
      await recheck((context) => context.projectId === event.projectId);
      // Connections that kept their access read their rights again (role changed).
      notifyProject(event.projectId, { type: 'access' });
      return;
    }
    if (event.type === 'comments-changed') {
      notifyProject(event.projectId, { type: 'comments' });
      return;
    }
    const name = fileDocumentName(event.projectId, event.fileId);
    const document = server.hocuspocus.documents.get(name);
    const state = docs.get(name);
    if (!document || !state) return;
    if (event.type === 'file-deleted') {
      state.dirty = false;
      for (const connection of document.getConnections()) {
        connection.close(COLLAB_CLOSE.deleted);
      }
      return;
    }
    if (event.type === 'file-locked') {
      // Nothing more is stored: the changes not stored yet are dropped (the state before the
      // validation is a version of the history). The document takes the validated text, then
      // its editors open it again from that text, read-only.
      clearTimeout(state.retry);
      state.dirty = false;
      const connections = document.getConnections();
      for (const connection of connections) connection.readOnly = true;
      const loaded = await api.load(event.projectId, event.fileId);
      if (loaded.text !== null) applyText(textOf(document), loaded.text, LOAD_ORIGIN);
      state.baseState = Y.encodeStateAsUpdate(document);
      state.baseKey = loaded.key;
      state.dirty = false;
      for (const connection of document.getConnections()) {
        connection.close(COLLAB_CLOSE.locked);
      }
      return;
    }
    const loaded = await api.load(event.projectId, event.fileId);
    if (loaded.text === null || loaded.key === state.baseKey) return;
    // Sent to everyone as a change, then stored like any edit.
    state.baseState = mergeText(document, state.baseState, loaded.text, REPLACE_ORIGIN);
    state.baseKey = loaded.key;
  }

  const timer = setInterval(() => {
    // Sockets not seen for a while are forgotten.
    const old = Date.now() - 10 * options.recheckMs;
    for (const [socketId, counts] of sockets) if (counts.seen < old) sockets.delete(socketId);
    void recheck();
  }, options.recheckMs);
  timer.unref();

  return {
    server,
    handleEvent,
    recheck,
    async destroy() {
      clearInterval(timer);
      for (const state of docs.values()) clearTimeout(state.retry);
      // Hocuspocus stores the changed documents before closing.
      await server.destroy();
    },
  };
}
