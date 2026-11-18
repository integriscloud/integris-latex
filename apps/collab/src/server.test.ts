import { request } from 'node:http';
import type { Server } from '@hocuspocus/server';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticate, createCollabServer } from './server.js';

function get(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    })
      .on('error', reject)
      .end();
  });
}

function upgrade(port: number, path: string): Promise<'opened' | 'refused'> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    socket.onopen = () => {
      socket.close();
      resolve('opened');
    };
    socket.onerror = () => resolve('refused');
  });
}

describe('collab server', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createCollabServer({ port: 0, logger: pino({ level: 'silent' }) });
    await server.listen();
    port = server.address.port;
  });

  afterAll(async () => {
    await server.destroy();
  });

  it('answers the health check', async () => {
    expect(await get(port, '/collab/health')).toBe(200);
  });

  it('serves nothing else over HTTP', async () => {
    expect(await get(port, '/')).toBe(404);
  });

  it('accepts WebSocket upgrades on /collab only', async () => {
    expect(await upgrade(port, '/other')).toBe('refused');
    expect(await upgrade(port, '/collab')).toBe('opened');
  });

  it('refuses every connection until authentication exists', async () => {
    await expect(authenticate()).rejects.toThrow(/step 7/);
  });
});
