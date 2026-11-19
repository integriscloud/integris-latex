import { COMPILE_OUTPUT_BUCKET, PORTS } from '@integris/shared';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pipeline } from 'node:stream';
import { ApiConfig } from '../config/api-config.js';
import { StorageService } from '../storage/storage.service.js';
import { fileLinkKey, verifyFileLink } from './file-links.js';

/** "/pdf/<token>/<name>.pdf": the name is only there for the browser's download dialog. */
const PDF_PATH = /^\/pdf\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+\.pdf)$/;

/** Headers of every answer of the files domain (CLAUDE.md, "Security rules"). */
const BASE_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'cross-origin',
} as const;

/**
 * Server of the files domain (latex-files.integriscloud.com), on its own port in the API
 * process: it only answers signed links to compiled PDFs, never sets or reads a cookie, and has
 * no route of the app. Nginx proxies the files domain, and only it, to this port.
 */
@Injectable()
export class FilesServer implements OnModuleDestroy {
  private readonly logger = new Logger(FilesServer.name);
  private readonly key: Buffer;
  private server: Server | null = null;

  constructor(
    private readonly config: ApiConfig,
    private readonly storage: StorageService,
  ) {
    this.key = fileLinkKey(config.env.AUTH_SECRET);
  }

  /** Started by main.ts only (tests call `handle` directly). */
  listen(port: number = PORTS.files): Promise<void> {
    this.server = createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        this.logger.error({ err: (error as Error).message }, 'File delivery failed');
        if (!response.headersSent) this.answer(response, 500);
        else response.destroy();
      });
    });
    return new Promise((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
  }

  private answer(response: ServerResponse, status: number, headers: Record<string, string> = {}) {
    response.writeHead(status, { ...BASE_HEADERS, 'Cache-Control': 'no-store', ...headers });
    response.end();
  }

  /** CORS for the app's origins: PDF.js downloads the PDF with fetch. */
  private cors(request: IncomingMessage): Record<string, string> {
    const origin = request.headers.origin;
    return origin && this.config.env.WEB_ORIGINS.includes(origin)
      ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
      : { Vary: 'Origin' };
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET';
    if (method === 'OPTIONS') {
      this.answer(response, 204, {
        ...this.cors(request),
        'Access-Control-Allow-Methods': 'GET, HEAD',
        'Access-Control-Max-Age': '600',
      });
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      this.answer(response, 405, { Allow: 'GET, HEAD, OPTIONS' });
      return;
    }
    const path = new URL(request.url ?? '/', 'http://files').pathname;
    const match = path.match(PDF_PATH);
    const link = match ? verifyFileLink(this.key, match[1]!) : null;
    // Signed links only point at PDFs of compile-output.
    if (!match || !link || !link.key.endsWith('.pdf')) {
      this.answer(response, 404, this.cors(request));
      return;
    }
    const object = await this.storage.open(COMPILE_OUTPUT_BUCKET, link.key);
    if (!object) {
      this.answer(response, 404, this.cors(request));
      return;
    }
    const maxAge = Math.max(0, link.expires - Math.floor(Date.now() / 1000));
    response.writeHead(200, {
      ...BASE_HEADERS,
      ...this.cors(request),
      'Content-Type': 'application/pdf',
      'Content-Length': String(object.size),
      'Content-Disposition': `${link.download ? 'attachment' : 'inline'}; filename="${match[2]}"`,
      'Cache-Control': `private, max-age=${maxAge}`,
    });
    if (method === 'HEAD') {
      object.body.destroy();
      response.end();
      return;
    }
    // pipeline closes the storage stream when the client goes away: an aborted download never
    // keeps a connection of the shared storage client.
    pipeline(object.body, response, () => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    await new Promise((resolve) => (this.server ? this.server.close(resolve) : resolve(null)));
  }
}
