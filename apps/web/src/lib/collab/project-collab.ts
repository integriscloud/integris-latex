import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import {
  type AwarenessUser,
  awarenessUserSchema,
  COLLAB_CLOSE,
  COLLAB_PATH,
  type CollabServerMessage,
  collabServerMessageSchema,
  FILE_TEXT_NAME,
  fileDocumentName,
  PORTS,
  presenceDocumentName,
  type StoreBlockCode,
} from '@integris/shared';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

/** Where the browser opens the collaboration socket. */
export function collabUrl(location: Pick<Location, 'protocol' | 'host' | 'hostname' | 'port'>) {
  // Reached directly on the web port (local runs, tests), nothing proxies the socket: the
  // collaboration server is on its own port of the same host. Nginx routes it otherwise.
  if (location.port === String(PORTS.web)) {
    return `ws://${location.hostname}:${PORTS.collab}${COLLAB_PATH}`;
  }
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${COLLAB_PATH}`;
}

/** State of an open file, as the editor shows it. */
export interface FileSnapshot {
  /** First synchronization done: the text is the shared one. */
  synced: boolean;
  /** The server lets this connection change the file (owner, editor; file and project open). */
  writable: boolean;
  /** Local changes the server has not acknowledged yet. */
  unsynced: number;
  /** Something was typed in this page since the file was opened. */
  edited: boolean;
  /** Why the last write to storage was refused, if it was. */
  storeCode: StoreBlockCode | null;
  /** The connection to this file ended: right lost, or file deleted. */
  closed: 'revoked' | 'deleted' | null;
}

/** Someone else in the project, from the presence document. */
export interface Peer {
  clientId: number;
  user: AwarenessUser;
  fileId: string | null;
}

export interface FileSession {
  fileId: string;
  doc: Y.Doc;
  provider: HocuspocusProvider;
  /** What the code editor binds to (stable for the life of the session). */
  shared: { text: Y.Text; awareness: Awareness; undoManager: Y.UndoManager };
  snapshot: FileSnapshot;
}

/** A change of the text of an open file; `local` when typed in this page. */
export type TextListener = (fileId: string, text: string, local: boolean) => void;

export interface CollabSnapshot {
  connected: boolean;
  files: ReadonlyMap<string, FileSnapshot>;
  peers: readonly Peer[];
  /** Identity given by the server (null until the presence document is authenticated). */
  me: AwarenessUser | null;
}

const FLUSH_TIMEOUT_MS = 20_000;

/**
 * Presence after a (re)connection. When a connection closes, the server marks this page's state
 * removed one clock step ahead, and this page does the same for the states of the others: states
 * sent again with their old clock would be ignored on both sides until two renewals (30 s), so
 * the others would not show. The others are taken as they come, and this state is sent ahead of
 * the removal.
 */
export function rejoin(awareness: Awareness) {
  for (const clientId of [...awareness.meta.keys()]) {
    if (clientId !== awareness.clientID && !awareness.states.has(clientId)) {
      awareness.meta.delete(clientId);
    }
  }
  const state = awareness.getLocalState();
  if (state === null) return;
  awareness.setLocalState({ ...state });
  awareness.setLocalState({ ...state });
}

function parseServerMessage(payload: string): CollabServerMessage | null {
  try {
    const message = collabServerMessageSchema.safeParse(JSON.parse(payload));
    return message.success ? message.data : null;
  } catch {
    return null;
  }
}

/**
 * Collaboration of one project: one WebSocket for every document, a presence document (who is
 * online and in which file) and one Yjs document per open text file. Changes are kept in the
 * page while the connection is down and sent when it comes back.
 */
export class ProjectCollab {
  private readonly socket: HocuspocusProviderWebsocket;
  private readonly presence: HocuspocusProvider;
  private readonly sessions = new Map<string, FileSession>();
  private readonly listeners = new Set<() => void>();
  private readonly textListeners = new Set<TextListener>();
  private readonly deletedListeners = new Set<(fileId: string) => void>();
  private readonly lockedListeners = new Set<(fileId: string) => void>();
  private readonly projectListeners = new Set<(change: 'comments' | 'access') => void>();
  private readonly flushes = new Map<number, (code: StoreBlockCode | null) => void>();
  private nextFlush = 1;
  private everConnected = false;
  private snapshot: CollabSnapshot;

  constructor(
    private readonly projectId: string,
    url: string,
  ) {
    // Connected by the editor once mounted (see connect).
    this.socket = new HocuspocusProviderWebsocket({ url, autoConnect: false });
    this.presence = new HocuspocusProvider({
      websocketProvider: this.socket,
      name: presenceDocumentName(projectId),
      // Sessions travel in the cookie; the token only starts the authentication exchange.
      token: 'session',
    });
    this.presence.on('authenticated', () => rejoin(this.presence.awareness!));
    this.presence.attach();
    this.snapshot = { connected: false, files: new Map(), peers: [], me: null };
    this.socket.on('status', ({ status }: { status: string }) => {
      if (status === 'connected') this.everConnected = true;
      this.changed();
    });
    this.presence.awareness!.on('change', () => this.changed());
    // The server tells every editor of the project when comments or rights change.
    this.presence.on('stateless', ({ payload }: { payload: string }) => {
      const message = parseServerMessage(payload);
      if (message?.type === 'comments' || message?.type === 'access') {
        for (const listener of this.projectListeners) listener(message.type);
      }
    });
  }

  // The browser knows first when the network goes: the socket follows at once instead of
  // waiting for its own timeout, so the editor says "offline" while the changes wait here.
  private readonly online = () => void this.socket.connect();
  private readonly offline = () => this.socket.disconnect();

  connect() {
    window.addEventListener('online', this.online);
    window.addEventListener('offline', this.offline);
    if (navigator.onLine) void this.socket.connect();
  }

  /** Disconnects without forgetting anything: open files keep their changes. */
  disconnect() {
    window.removeEventListener('online', this.online);
    window.removeEventListener('offline', this.offline);
    this.socket.disconnect();
  }

  /** Listens to the texts of the open files (index, outline, automatic compilation). */
  onText(listener: TextListener) {
    this.textListeners.add(listener);
    return () => {
      this.textListeners.delete(listener);
    };
  }

  /** Comments of the project changed, or the rights on it (read them again). */
  onProjectChange(listener: (change: 'comments' | 'access') => void) {
    this.projectListeners.add(listener);
    return () => {
      this.projectListeners.delete(listener);
    };
  }

  /** A file open here was deleted from the project (by anyone): it is closed first. */
  onDeleted(listener: (fileId: string) => void) {
    this.deletedListeners.add(listener);
    return () => {
      this.deletedListeners.delete(listener);
    };
  }

  /**
   * A file open here was locked by a validated submission: its changes not stored are dropped
   * and it is opened again with the validated text, read-only.
   */
  onLocked(listener: (fileId: string) => void) {
    this.lockedListeners.add(listener);
    return () => {
      this.lockedListeners.delete(listener);
    };
  }

  // ───────────── Store of the React state ─────────────

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  private changed() {
    const states = this.presence.awareness!.getStates();
    const own = this.presence.awareness!.clientID;
    const peers: Peer[] = [];
    let me: AwarenessUser | null = null;
    for (const [clientId, state] of states) {
      // The server sets `user` from the session: an unknown shape is someone not yet known.
      const user = awarenessUserSchema.safeParse(state.user);
      if (!user.success) continue;
      if (clientId === own) {
        me = user.data;
        continue;
      }
      const fileId = typeof state.fileId === 'string' ? state.fileId : null;
      peers.push({ clientId, user: user.data, fileId });
    }
    this.snapshot = {
      connected: this.socket.status === 'connected',
      files: new Map([...this.sessions].map(([id, session]) => [id, { ...session.snapshot }])),
      peers,
      me,
    };
    for (const listener of this.listeners) listener();
  }

  // ───────────── Files ─────────────

  session(fileId: string): FileSession | undefined {
    return this.sessions.get(fileId);
  }

  /** Opens a file (once): its document is kept while the editor is open. */
  open(fileId: string): FileSession {
    const existing = this.sessions.get(fileId);
    if (existing) return existing;
    const doc = new Y.Doc();
    const text = doc.getText(FILE_TEXT_NAME);
    const provider = new HocuspocusProvider({
      websocketProvider: this.socket,
      name: fileDocumentName(this.projectId, fileId),
      document: doc,
      token: 'session',
    });
    const session: FileSession = {
      fileId,
      doc,
      provider,
      shared: { text, awareness: provider.awareness!, undoManager: new Y.UndoManager(text) },
      snapshot: {
        synced: false,
        writable: false,
        unsynced: 0,
        edited: false,
        storeCode: null,
        closed: null,
      },
    };
    text.observe((event) => {
      const value = text.toString();
      for (const listener of this.textListeners) listener(fileId, value, event.transaction.local);
    });
    const update = (patch: Partial<FileSnapshot>) => {
      session.snapshot = { ...session.snapshot, ...patch };
      this.changed();
    };
    // Changes that do not come from the server were made here.
    doc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin !== provider && !session.snapshot.edited) update({ edited: true });
    });
    provider.on('authenticated', ({ scope }: { scope: string }) => {
      rejoin(provider.awareness!);
      update({ writable: scope === 'read-write', closed: null });
    });
    provider.on('authenticationFailed', () => update({ writable: false, closed: 'revoked' }));
    provider.on('synced', ({ state }: { state: boolean }) => update({ synced: state }));
    provider.on('unsyncedChanges', ({ number }: { number: number }) =>
      update({ unsynced: number }),
    );
    provider.on('close', ({ event }: { event: { reason?: string } }) => {
      if (event.reason === COLLAB_CLOSE.revoked.reason)
        update({ writable: false, closed: 'revoked' });
      if (event.reason === COLLAB_CLOSE.deleted.reason)
        update({ writable: false, closed: 'deleted' });
      // Once the socket is done with this close: a new document, read from the server.
      if (event.reason === COLLAB_CLOSE.locked.reason) {
        setTimeout(() => {
          if (this.sessions.get(fileId) !== session) return;
          this.close(fileId);
          this.open(fileId);
          for (const listener of this.lockedListeners) listener(fileId);
        }, 0);
      }
    });
    provider.on('stateless', ({ payload }: { payload: string }) => {
      const message = parseServerMessage(payload);
      if (message?.type === 'stored') {
        update({ storeCode: message.code });
      } else if (message?.type === 'flushed') {
        update({ storeCode: message.code });
        this.flushes.get(message.id)?.(message.code);
        this.flushes.delete(message.id);
      }
    });
    provider.attach();
    this.sessions.set(fileId, session);
    this.changed();
    return session;
  }

  /** Resolves once the file holds the shared text (or rejects after `ms`). */
  whenSynced(fileId: string, ms = FLUSH_TIMEOUT_MS): Promise<FileSession> {
    const session = this.open(fileId);
    if (session.snapshot.synced) return Promise.resolve(session);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error('not synced'));
      }, ms);
      const unsubscribe = this.subscribe(() => {
        if (session.snapshot.synced) {
          clearTimeout(timer);
          unsubscribe();
          resolve(session);
        } else if (session.snapshot.closed) {
          clearTimeout(timer);
          unsubscribe();
          reject(new Error(session.snapshot.closed));
        }
      });
    });
  }

  /** Tells the others which file is shown. */
  setActiveFile(fileId: string | null) {
    this.presence.awareness!.setLocalStateField('fileId', fileId);
  }

  /**
   * Writes the open files to storage now (before a compilation or a named version): waits until
   * the server has every local change, then asks it to store. True when everything is stored.
   */
  async flush(): Promise<{ ok: boolean; code: StoreBlockCode | 'offline' | null }> {
    const writable = [...this.sessions.values()].filter(
      (session) => session.snapshot.writable && !session.snapshot.closed,
    );
    try {
      const codes = await Promise.all(writable.map((session) => this.flushOne(session)));
      const code = codes.find((value) => value !== null) ?? null;
      return { ok: code === null, code };
    } catch {
      return { ok: false, code: 'offline' };
    }
  }

  private async flushOne(session: FileSession): Promise<StoreBlockCode | null> {
    const deadline = Date.now() + FLUSH_TIMEOUT_MS;
    while (session.provider.unsyncedChanges > 0 || !session.provider.isSynced) {
      if (Date.now() > deadline || session.snapshot.closed) throw new Error('offline');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const id = this.nextFlush++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.flushes.delete(id);
        reject(new Error('offline'));
      }, FLUSH_TIMEOUT_MS);
      this.flushes.set(id, (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      session.provider.sendStateless(JSON.stringify({ type: 'flush', id }));
    });
  }

  /** Changes not yet received by the server (asked before leaving the page). */
  hasUnsyncedChanges(): boolean {
    return [...this.sessions.values()].some(
      (session) => session.snapshot.writable && session.provider.unsyncedChanges > 0,
    );
  }

  /** The connection worked, then was lost (network gone, server unreachable). */
  isCutOff(): boolean {
    return this.everConnected && this.socket.status !== 'connected';
  }

  /** Forgets a file (deleted from the project). */
  close(fileId: string) {
    const session = this.sessions.get(fileId);
    if (!session) return;
    session.shared.undoManager.destroy();
    session.provider.destroy();
    session.doc.destroy();
    this.sessions.delete(fileId);
    this.changed();
  }

  destroy() {
    for (const fileId of [...this.sessions.keys()]) this.close(fileId);
    this.presence.destroy();
    this.socket.destroy();
    this.listeners.clear();
    this.textListeners.clear();
    this.deletedListeners.clear();
    this.lockedListeners.clear();
    this.projectListeners.clear();
  }
}
