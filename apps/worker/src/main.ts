import './load-env.js';
import { COMPILE_QUEUE, parseEnv, workerEnvSchema } from '@integris/shared';
import { Worker } from 'bullmq';
import { hostname } from 'node:os';
import { pino } from 'pino';
import { createCompileProcessor } from './compile.js';
import { removeLeftoverSandboxes, runSandbox } from './sandbox.js';
import { WorkerStorage } from './storage.js';

// Workers only reach Redis and MinIO: load-env.ts copies nothing else from .env.
const env = parseEnv(workerEnvSchema, process.env);
const logger = pino({ name: 'worker', level: env.NODE_ENV === 'production' ? 'info' : 'debug' });
const storage = new WorkerStorage(env);

const workerName = env.WORKER_NAME ?? hostname();
const removed = await removeLeftoverSandboxes(workerName);
if (removed) logger.warn({ removed }, 'removed sandboxes left by a previous run');

const worker = new Worker(
  COMPILE_QUEUE,
  createCompileProcessor({
    env,
    storage,
    runSandbox,
    logger,
    workerName,
  }),
  {
    connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
    concurrency: env.COMPILE_CONCURRENCY,
    // A compilation takes at most a few minutes; the lock is renewed while it runs.
    lockDuration: 60_000,
  },
);

worker.on('ready', () => logger.info({ queue: COMPILE_QUEUE }, 'worker connected to Redis'));
// Job data holds presigned URLs: only ids are logged.
worker.on('failed', (job, error) =>
  logger.warn({ jobId: job?.id, err: error.message }, 'job failed'),
);
worker.on('error', (error) => logger.error({ err: error.message }, 'worker error'));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'worker stopping');
    void worker.close().then(() => {
      storage.destroy();
      process.exit(0);
    });
  });
}
