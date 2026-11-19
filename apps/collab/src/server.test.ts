import { request } from 'node:http';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import {
  type AuthorizeRequest,
  type AuthorizeResponse,
  FILE_TEXT_NAME,
  fileDocumentName,
  presenceDocumentName,
  type StoreRequest,
  type StoreResponse,
} from '@integris/shared';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type * as Y from 'yjs';
import type { CollabApi } from './api-client.js';
import { type CollabServer, cookieValue, createCollabServer } from './server.js';

const ORIGIN = 'https://test-latex.integriscloud.com';
const PROJECT = 'cproject000000000000001';
const FILE = 'cfile000000000000000001';
const DOC = fileDocumentName(PROJECT, FILE);

// Session cookies are 32 random bytes in base64url: the test names are padded to that shape.
const SESSION_SUFFIX = '-0123456789abcdefghij';

type Role = 'OWNER' | 'EDITOR' | 'SUPERVISOR' | 'REVIEWER' | 'VIEWER';

/** In-memory stand-in for the internal API: sessions map to a user and a role. */
class FakeApi implements CollabApi {
  roles = new Map<string, Role>();
  readOnlyProject = false;
  text = 'Hello';
  key = 'k0';
  state: string | null = null;
  stores: StoreRequest[] = [];
  storeCode: StoreResponse['code'] = null;
  authorizeCalls = 0;

  async authorize(input: AuthorizeRequest): Promise<AuthorizeResponse> {
    this.authorizeCalls++;
    const session = input.session.replace(SESSION_SUFFIX, '');
    const role = this.roles.get(session);
    if (!role || input.projectId !== PROJECT) return { ok: false };
    const editor = role === 'OWNER' || role === 'EDITOR';
    return {
      ok: true,
      user: { id: `u-${session}`, name: `Name ${session}`, color: 2, editor },
      writable: input.fileId !== null && editor && !this.readOnlyProject,
    };
  }

  async load() {
    return { state: this.state, text: this.state ? null : this.text, key: this.key };
  }

  async store(input: StoreRequest): Promise<StoreResponse> {
    this.stores.push(input);
    if (input.baseKey !== this.key) return { code: null, text: this.text, key: this.key };
    this.state = input.state;
    if (this.storeCode) return { code: this.storeCode, text: null, key: this.key };
    this.text = input.text;
    this.key = `k${this.stores.length}`;
    return { code: null, text: null, key: this.key };
  }
}

function socketClass(session: string | null, origin = ORIGIN) {
  return class extends WebSocket {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols, {
        headers: {
          origin,
          ...(session ? { cookie: `other=1; __Host-session=${session}${SESSION_SUFFIX}` } : {}),
        },
      });
    }
  };
}

interface Client {
  provider: HocuspocusProvider;
  socket: HocuspocusProviderWebsocket;
  text: Y.Text;
  readOnly: () => boolean | undefined;
  failed: () => string | null;
  stateless: string[];
}

const until = async (check: () => boolean, ms = 4000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe('collab server', () => {
  let collab: CollabServer;
  let api: FakeApi;
  let port: number;
  const clients: Client[] = [];

  function connect(session: string | null, name = DOC, origin = ORIGIN): Client {
    const socket = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}/collab`,
      WebSocketPolyfill: socketClass(session, origin),
      maxAttempts: 1,
    });
    let failure: string | null = null;
    let readOnly: boolean | undefined;
    const stateless: string[] = [];
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name,
      token: 'cookie',
      onAuthenticated: ({ scope }) => {
        readOnly = scope === 'readonly';
      },
      onAuthenticationFailed: ({ reason }) => {
        failure = reason;
      },
      onStateless: ({ payload }) => stateless.push(payload),
    });
    provider.attach();
    const client = {
      provider,
      socket,
      text: provider.document.getText(FILE_TEXT_NAME),
      readOnly: () => readOnly,
      failed: () => failure,
      stateless,
    };
    clients.push(client);
    return client;
  }

  const synced = (client: Client) => until(() => client.provider.isSynced);
  const serverText = () =>
    collab.server.hocuspocus.documents.get(DOC)?.getText(FILE_TEXT_NAME).toString();

  beforeAll(async () => {
    api = new FakeApi();
    collab = createCollabServer({
      port: 0,
      logger: pino({ level: process.env.DBG ? 'debug' : 'silent' }),
      api,
      webOrigins: [ORIGIN],
      recheckMs: 60_000,
      debounceMs: 50,
      maxDebounceMs: 200,
      maxStateBytes: 64 * 1024,
    });
    await collab.server.listen();
    port = collab.server.address.port;
  });

  beforeEach(() => {
    Object.assign(api, new FakeApi());
    for (const role of ['OWNER', 'EDITOR', 'SUPERVISOR', 'REVIEWER', 'VIEWER'] as const) {
      api.roles.set(role.toLowerCase(), role);
    }
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.provider.destroy();
      client.socket.destroy();
    }
    await until(() => collab.server.hocuspocus.getConnectionsCount() === 0);
    await until(() => collab.server.hocuspocus.documents.size === 0);
  });

  afterAll(async () => {
    await collab.destroy();
  });

  it('answers the health check and serves nothing else over HTTP', async () => {
    const get = (path: string) =>
      new Promise<number>((resolve, reject) => {
        request({ host: '127.0.0.1', port, path }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
          .on('error', reject)
          .end();
      });
    expect(await get('/collab/health')).toBe(200);
    expect(await get('/')).toBe(404);
  });

  it('refuses WebSockets from another origin or on another path', async () => {
    const open = (path: string, origin: string) =>
      new Promise<string>((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { origin } });
        socket.on('open', () => {
          socket.close();
          resolve('opened');
        });
        socket.on('error', () => resolve('refused'));
      });
    expect(await open('/collab', 'https://evil.example')).toBe('refused');
    expect(await open('/other', ORIGIN)).toBe('refused');
    expect(await open('/collab', ORIGIN)).toBe('opened');
  });

  it('refuses a connection without a valid session or with a foreign document name', async () => {
    const anonymous = connect(null);
    const stranger = connect('stranger');
    const forged = connect('owner', 'file:../../etc:passwd');
    await until(() => [anonymous, stranger, forged].every((client) => client.failed() !== null));
    expect(api.stores).toHaveLength(0);
  });

  it('lets owners and editors write, and loads the stored text', async () => {
    const owner = connect('owner');
    const editor = connect('editor');
    await synced(owner);
    await synced(editor);
    expect(owner.readOnly()).toBe(false);
    expect(editor.readOnly()).toBe(false);
    expect(owner.text.toString()).toBe('Hello');
    owner.text.insert(5, ' world');
    editor.text.insert(0, '>> ');
    await until(() => owner.text.toString() === editor.text.toString());
    expect(owner.text.toString()).toBe('>> Hello world');
    await until(() => api.text === '>> Hello world');
  });

  it.each(['supervisor', 'reviewer', 'viewer'])(
    'keeps %s read-only on the server, whatever the client sends',
    async (session) => {
      const owner = connect('owner');
      const reader = connect(session);
      await synced(owner);
      await synced(reader);
      expect(reader.readOnly()).toBe(true);
      // The client ignores its read-only state: the server still refuses the change.
      reader.text.insert(0, 'forged ');
      owner.text.insert(5, '!');
      await until(() => reader.text.toString().includes('!'));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(serverText()).toBe('Hello!');
      expect(owner.text.toString()).toBe('Hello!');
      expect(api.stores.every((store) => !store.text.includes('forged'))).toBe(true);
    },
  );

  it('makes a read-only project read-only for its owner too', async () => {
    api.readOnlyProject = true;
    const owner = connect('owner');
    await synced(owner);
    expect(owner.readOnly()).toBe(true);
  });

  it('sets the identity of every cursor from the session, never from the client', async () => {
    const owner = connect('owner');
    const viewer = connect('viewer');
    await synced(owner);
    await synced(viewer);
    viewer.provider.awareness!.setLocalStateField('user', { name: 'Owner (fake)', color: 'red;' });
    viewer.provider.awareness!.setLocalStateField('script', '<img>');
    await until(() =>
      [...owner.provider.awareness!.getStates().values()].some(
        (state) => (state.user as { id?: string } | undefined)?.id === 'u-viewer',
      ),
    );
    const seen = [...owner.provider.awareness!.getStates().entries()].find(
      ([id]) => id === viewer.provider.document.clientID,
    )?.[1];
    expect(seen).toEqual({
      user: {
        id: 'u-viewer',
        name: 'Name viewer',
        editor: false,
        colorIndex: 2,
        color: 'var(--presence-2)',
        colorLight: 'var(--presence-2-selection)',
      },
    });
  });

  it('writes to storage at once on flush and reports blocks', async () => {
    const owner = connect('owner');
    await synced(owner);
    owner.text.insert(0, 'x');
    await until(() => owner.provider.unsyncedChanges === 0);
    owner.provider.sendStateless(JSON.stringify({ type: 'flush', id: 7 }));
    await until(() => owner.stateless.some((message) => message.includes('"flushed"')));
    expect(JSON.parse(owner.stateless.find((m) => m.includes('"flushed"'))!)).toEqual({
      type: 'flushed',
      id: 7,
      code: null,
    });
    expect(api.text).toBe('xHello');

    api.storeCode = 'storage_limit';
    owner.text.insert(0, 'y');
    await until(() => owner.stateless.some((message) => message.includes('storage_limit')));
    // The edit is kept in the document state, not in storage.
    expect(api.text).toBe('xHello');
  });

  it('stores for writers only, and not again while blocked', async () => {
    const owner = connect('owner');
    const viewer = connect('viewer');
    await synced(owner);
    await synced(viewer);
    viewer.provider.sendStateless(JSON.stringify({ type: 'flush', id: 1 }));
    await until(() => viewer.stateless.some((message) => message.includes('"flushed"')));
    expect(api.stores).toHaveLength(0);

    api.storeCode = 'storage_limit';
    owner.text.insert(0, 'x');
    await until(() => owner.stateless.some((message) => message.includes('storage_limit')));
    const stores = api.stores.length;
    await new Promise((resolve) => setTimeout(resolve, 2100));
    owner.provider.sendStateless(JSON.stringify({ type: 'flush', id: 2 }));
    await until(() => owner.stateless.some((message) => message.includes('"id":2')));
    // Blocked: nothing is sent again until the text changes.
    expect(api.stores).toHaveLength(stores);
  });

  it('refuses changes that would make a document too large', async () => {
    const owner = connect('owner');
    await synced(owner);
    owner.text.insert(0, 'a'.repeat(80 * 1024));
    await until(
      () => collab.server.hocuspocus.getConnectionsCount() === 0 || owner.failed() !== null,
    );
    expect(serverText()?.length ?? 0).toBeLessThan(80 * 1024);
  });

  it('drops malformed cursors and never lets a client id be taken over', async () => {
    const owner = connect('owner');
    const viewer = connect('viewer');
    await synced(owner);
    await synced(viewer);
    viewer.provider.awareness!.setLocalStateField('cursor', { anchor: 'x'.repeat(5000), head: 1 });
    await until(() =>
      [...owner.provider.awareness!.getStates().values()].some(
        (state) => (state.user as { id?: string } | undefined)?.id === 'u-viewer',
      ),
    );
    const seen = owner.provider.awareness!.getStates().get(viewer.provider.document.clientID);
    expect(seen).not.toHaveProperty('cursor');
  });

  it('merges text replaced outside the editor as a diff', async () => {
    const owner = connect('owner');
    await synced(owner);
    // A restoration wrote new content: the next store finds another key.
    api.text = 'Hello there';
    api.key = 'restored';
    owner.text.insert(0, 'A');
    await until(() => owner.text.toString() === 'AHello there');
    await until(() => api.text === 'AHello there');

    api.text = 'Bye';
    api.key = 'restored-2';
    api.state = null;
    await collab.handleEvent({ type: 'file-replaced', projectId: PROJECT, fileId: FILE });
    await until(() => owner.text.toString() === 'Bye');
  });

  it('disconnects a user whose right is gone, and everyone from a deleted file', async () => {
    const owner = connect('owner');
    const editor = connect('editor');
    await synced(owner);
    await synced(editor);
    api.roles.delete('editor');
    await collab.handleEvent({ type: 'project-access', projectId: PROJECT });
    await until(() => editor.failed() !== null || editor.provider.isSynced === false);
    expect(collab.server.hocuspocus.documents.get(DOC)?.getConnectionsCount()).toBe(1);

    await collab.handleEvent({ type: 'file-deleted', projectId: PROJECT, fileId: FILE });
    await until(
      () => (collab.server.hocuspocus.documents.get(DOC)?.getConnectionsCount() ?? 0) === 0,
    );
  });

  it('makes an editor read-only at once when the owner changes the role, and tells the editors', async () => {
    const editor = connect('editor');
    const presence = connect('editor', presenceDocumentName(PROJECT));
    await synced(editor);
    await synced(presence);
    expect(editor.readOnly()).toBe(false);
    api.roles.set('editor', 'REVIEWER');
    await collab.handleEvent({ type: 'project-access', projectId: PROJECT });
    await until(() => presence.stateless.some((payload) => JSON.parse(payload).type === 'access'));
    // The server now refuses the changes of this connection.
    editor.text.insert(0, 'refused ');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(serverText()).not.toContain('refused');
  });

  it('tells the editors open on a project that its comments changed', async () => {
    const reviewer = connect('reviewer', presenceDocumentName(PROJECT));
    await synced(reviewer);
    await collab.handleEvent({ type: 'comments-changed', projectId: PROJECT });
    await until(() => reviewer.stateless.includes(JSON.stringify({ type: 'comments' })));
    // Other projects are not told.
    await collab.handleEvent({ type: 'comments-changed', projectId: 'other-project-1' });
    expect(reviewer.stateless.filter((payload) => payload.includes('comments'))).toHaveLength(1);
  });

  it('gives presence documents to every role, read-only and without storage', async () => {
    const viewer = connect('viewer', presenceDocumentName(PROJECT));
    await synced(viewer);
    expect(viewer.readOnly()).toBe(true);
    expect(api.stores).toHaveLength(0);
  });
});

describe('cookieValue', () => {
  it('reads one cookie of the header', () => {
    expect(cookieValue('a=1; __Host-session=abc; b=2', '__Host-session')).toBe('abc');
    expect(cookieValue('x__Host-session=abc', '__Host-session')).toBeNull();
    expect(cookieValue(null, '__Host-session')).toBeNull();
  });
});
