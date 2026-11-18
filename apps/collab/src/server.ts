import type { IncomingMessage } from 'node:http';
import { Server } from '@hocuspocus/server';
import { COLLAB_PATH } from '@integris/shared';
import type { Logger } from 'pino';

export const HEALTH_PATH = `${COLLAB_PATH}/health`;

function pathnameOf(request: IncomingMessage): string {
  return new URL(request.url ?? '/', 'http://localhost').pathname;
}

/**
 * Every collaboration connection must be authorized server-side. Until sessions (step 3) and
 * project permissions (steps 7–8) exist, nobody is allowed in.
 */
export async function authenticate(): Promise<never> {
  throw new Error('Collaboration is not available yet: authentication arrives in step 7.');
}

export interface CollabServerOptions {
  port: number;
  logger: Logger;
}

export function createCollabServer({ port, logger }: CollabServerOptions): Server {
  return new Server({
    name: 'integris-collab',
    port,
    // Nginx on the same host is the only public entry point.
    address: '127.0.0.1',
    quiet: true,
    // Handled in main.ts so that shutdown is logged.
    stopOnSignals: false,
    // Applies before authentication: bound what a single connection can make us buffer.
    websocketOptions: { maxPayload: 4 * 1024 * 1024 },

    async onUpgrade({ request, socket }) {
      if (pathnameOf(request) === COLLAB_PATH) return;
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      // An empty rejection stops Hocuspocus without crashing the server.
      return Promise.reject();
    },

    async onRequest({ request, response }) {
      const healthy = request.method === 'GET' && pathnameOf(request) === HEALTH_PATH;
      response.writeHead(healthy ? 200 : 404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(healthy ? { status: 'ok' } : { error: 'Not Found' }));
      return Promise.reject();
    },

    async onAuthenticate({ documentName, socketId }) {
      // The document name is client-controlled (up to maxPayload): never log it whole.
      logger.debug(
        {
          documentName: documentName.slice(0, 128),
          documentNameLength: documentName.length,
          socketId,
        },
        'collab connection refused',
      );
      return authenticate();
    },
  });
}
