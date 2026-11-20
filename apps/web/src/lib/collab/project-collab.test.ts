import { describe, expect, it } from 'vitest';
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import * as Y from 'yjs';
import { collabUrl, rejoin } from './project-collab';

const at = (url: string) => {
  const { protocol, host, hostname, port } = new URL(url);
  return { protocol, host, hostname, port };
};

describe('collabUrl', () => {
  it('uses the path proxied by Nginx on the app origin', () => {
    expect(collabUrl(at('https://latex.integriscloud.com/fr/app'))).toBe(
      'wss://latex.integriscloud.com/collab',
    );
    expect(collabUrl(at('http://localhost:8080/'))).toBe('ws://localhost:8080/collab');
  });

  it('reaches the collaboration port directly when the web port is opened without Nginx', () => {
    expect(collabUrl(at('http://127.0.0.1:3000/fr/app'))).toBe('ws://127.0.0.1:1234/collab');
  });
});

describe('presence after a reconnection', () => {
  /** One page and the server's copy of the presence. */
  const setup = () => {
    const page = new Awareness(new Y.Doc());
    const other = new Awareness(new Y.Doc());
    const server = new Awareness(new Y.Doc());
    const send = (from: Awareness, to: Awareness, clients: number[]) =>
      applyAwarenessUpdate(to, encodeAwarenessUpdate(from, clients), 'remote');
    page.setLocalState({ fileId: 'a' });
    other.setLocalState({ fileId: 'b' });
    send(page, server, [page.clientID]);
    send(other, server, [other.clientID]);
    send(server, page, [other.clientID]);
    // The connection of the page closes: both sides take the other's states out.
    removeAwarenessStates(server, [page.clientID], null);
    removeAwarenessStates(page, [other.clientID], 'close');
    return { page, other, server, send };
  };

  it('shows the others again and is shown again at once', () => {
    const { page, other, server, send } = setup();
    rejoin(page);
    send(page, server, [page.clientID]);
    send(server, page, [other.clientID]);
    expect(server.getStates().get(page.clientID)).toEqual({ fileId: 'a' });
    expect(page.getStates().get(other.clientID)).toEqual({ fileId: 'b' });
  });

  it('would otherwise stay hidden (the clocks of the removal win)', () => {
    const { page, other, server, send } = setup();
    send(page, server, [page.clientID]);
    send(server, page, [other.clientID]);
    expect(server.getStates().has(page.clientID)).toBe(false);
    expect(page.getStates().has(other.clientID)).toBe(false);
  });
});
