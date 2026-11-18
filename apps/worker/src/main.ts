import './load-env.js';
import { COMPILE_QUEUE, parseEnv, workerEnvSchema } from '@integris/shared';
import { Worker } from 'bullmq';
import { pino } from 'pino';
import { processCompileJob } from './compile.js';

// Workers only reach Redis and MinIO: load-env.ts copies nothing else from .env.
const env = parseEnv(workerEnvSchema, process.env);
const logger = pino({ name: 'worker', level: env.NODE_ENV === 'production' ? 'info' : 'debug' });

const worker = new Worker(COMPILE_QUEUE, processCompileJob, {
  connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
  concurrency: 1,
});

worker.on('ready', () => logger.info({ queue: COMPILE_QUEUE }, 'worker connected to Redis'));
worker.on('failed', (job, error) => logger.warn({ jobId: job?.id, err: error }, 'job failed'));
worker.on('error', (error) => logger.error({ err: error }, 'worker error'));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'worker stopping');
    void worker.close().then(() => process.exit(0));
  });
}
