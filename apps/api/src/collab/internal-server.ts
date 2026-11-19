import {
  authorizeRequestSchema,
  COLLAB_SECRET_HEADER,
  INTERNAL_PATHS,
  loadRequestSchema,
  PORTS,
  storeRequestSchema,
} from '@integris/shared';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { z } from 'zod';
import { ApiConfig } from '../config/api-config.js';
import { CollabDocsService } from './collab-docs.service.js';

// The largest state (base64) and text accepted by storeRequestSchema, with room for JSON.
const MAX_BODY_BYTES = 52 * 1024 * 1024;

const digest = (value: string) => createHash('sha256').update(value).digest();

class BadRequest extends Error {}

/**
 * Internal API of the collaboration server, on its own loopback port that Nginx never proxies.
 * Every request carries COLLAB_INTERNAL_SECRET. It answers three things: may this session open
 * this document, load a document, store a document.
 */
@Injectable()
export class InternalServer implements OnModuleDestroy {
  private readonly logger = new Logger(InternalServer.name);
  private readonly secret: Buffer;
  private server: Server | null = null;

  constructor(
    config: ApiConfig,
    private readonly docs: CollabDocsService,
  ) {
    this.secret = digest(config.env.COLLAB_INTERNAL_SECRET);
  }

  /** Started by main.ts only (tests call `handle` directly). */
  listen(port: number = PORTS.internal): Promise<void> {
    this.server = createServer((request, response) => void this.handle(request, response));
    return new Promise((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
  }

  private answer(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
  }

  private authorized(request: IncomingMessage): boolean {
    const sent = request.headers[COLLAB_SECRET_HEADER];
    return typeof sent === 'string' && timingSafeEqual(digest(sent), this.secret);
  }

  private async body<T extends z.ZodType>(
    request: IncomingMessage,
    schema: T,
  ): Promise<z.infer<T>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new BadRequest('Body too large');
      chunks.push(chunk);
    }
    let json: unknown;
    try {
      json = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    } catch {
      throw new BadRequest('Invalid JSON');
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new BadRequest('Invalid body');
    return parsed.data;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      await this.route(request, response);
    } catch (error) {
      const status = error instanceof BadRequest ? 400 : 500;
      if (status === 500) this.logger.error({ err: error }, 'Internal request failed');
      if (!response.headersSent) this.answer(response, status, { error: status });
      else response.destroy();
    }
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.authorized(request)) {
      this.answer(response, 401, { error: 401 });
      return;
    }
    const path = new URL(request.url ?? '/', 'http://internal').pathname;
    if (request.method !== 'POST') {
      this.answer(response, 405, { error: 405 });
      return;
    }
    switch (path) {
      case INTERNAL_PATHS.authorize:
        this.answer(
          response,
          200,
          await this.docs.authorize(await this.body(request, authorizeRequestSchema)),
        );
        return;
      case INTERNAL_PATHS.load: {
        const { projectId, fileId } = await this.body(request, loadRequestSchema);
        try {
          this.answer(response, 200, await this.docs.load(projectId, fileId));
        } catch (error) {
          if ((error as { status?: number }).status !== 404) throw error;
          this.answer(response, 404, { error: 404 });
        }
        return;
      }
      case INTERNAL_PATHS.store:
        this.answer(
          response,
          200,
          await this.docs.store(await this.body(request, storeRequestSchema)),
        );
        return;
      default:
        this.answer(response, 404, { error: 404 });
    }
  }

  onModuleDestroy(): void {
    this.server?.close();
  }
}
