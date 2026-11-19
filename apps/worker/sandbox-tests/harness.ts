import {
  type CompileResult,
  type EngineValue,
  parseEnv,
  type WorkerEnv,
  workerEnvSchema,
} from '@integris/shared';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { compile } from '../src/compile.js';
import { runSandbox } from '../src/sandbox.js';

/** Secret given to the worker: it must never reach a compilation output. */
export const SUITE_SECRET = 'integris-malicious-suite-secret-7f3c9a';

export interface Outputs {
  result: CompileResult;
  log: string;
  pdf: Buffer | undefined;
  synctex: Buffer | undefined;
}

/**
 * The real chain of the worker (download by URL, gVisor sandbox, log reading, results), with
 * project files served by a local HTTP server standing for the presigned MinIO URLs and an
 * in-memory storage standing for the compilation buckets.
 */
export class SandboxHarness {
  private server: Server | null = null;
  private origin = '';
  private readonly served = new Map<string, Buffer>();
  readonly stored = new Map<string, Buffer>();

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const body = this.served.get(request.url ?? '');
      response.writeHead(body ? 200 : 404).end(body);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): void {
    this.server?.close();
  }

  private env(): WorkerEnv {
    return parseEnv(workerEnvSchema, {
      REDIS_URL: 'redis://127.0.0.1:6379',
      MINIO_ENDPOINT: this.origin,
      MINIO_WORKER_ACCESS_KEY: 'suite',
      MINIO_WORKER_SECRET_KEY: SUITE_SECRET,
      SANDBOX_RUNTIME: process.env.SANDBOX_RUNTIME ?? 'runsc',
    });
  }

  async compile(
    projectId: string,
    files: Map<string, Buffer>,
    options: { engine: EngineValue; seconds: number; mainFile?: string; compilationId?: string },
  ): Promise<Outputs> {
    for (const [path, data] of files) this.served.set(`/${projectId}/${path}`, data);
    const compilationId = options.compilationId ?? `${projectId}-${Date.now()}`;
    const result = await compile(
      {
        env: this.env(),
        storage: {
          get: async (bucket, key) => this.stored.get(`${bucket}/${key}`) ?? null,
          put: async (bucket, key, body) =>
            void this.stored.set(`${bucket}/${key}`, Buffer.from(body)),
          delete: async (bucket, key) => void this.stored.delete(`${bucket}/${key}`),
        },
        runSandbox,
        logger: pino({ level: 'silent' }),
        workerName: 'sandbox-tests',
      },
      {
        compilationId,
        projectId,
        engine: options.engine,
        mainFile: options.mainFile ?? 'main.tex',
        timeoutSeconds: options.seconds,
        files: [...files].map(([path, data]) => ({
          path,
          size: data.length,
          url: `${this.origin}/${projectId}/${path.split('/').map(encodeURIComponent).join('/')}`,
        })),
      },
    );
    const prefix = `compile-output/${projectId}/${compilationId}/`;
    return {
      result,
      log: this.stored.get(`${prefix}output.log`)?.toString('utf8') ?? '',
      pdf: this.stored.get(`${prefix}output.pdf`),
      synctex: this.stored.get(`${prefix}synctex.json.gz`),
    };
  }
}
