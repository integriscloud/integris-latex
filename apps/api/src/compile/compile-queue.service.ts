import {
  COMPILE_QUEUE,
  COMPILE_SOURCE_URL_SECONDS,
  type CompileJob,
  compileResultSchema,
  type CompileResult,
} from '@integris/shared';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { type Job, Queue, QueueEvents } from 'bullmq';
import { ApiConfig } from '../config/api-config.js';
import { RedisService } from '../redis/redis.service.js';

/** Data of a queued job: the worker reads `CompileJob`, `signedAt` tells when to renew the URLs. */
export type QueuedJob = CompileJob & { signedAt: number };

export interface CompileEventHandlers {
  active(compilationId: string): Promise<void>;
  completed(compilationId: string, result: CompileResult | null): Promise<void>;
  failed(compilationId: string): Promise<void>;
}

/**
 * The BullMQ compilation queue seen from the API: adding and removing jobs, their place in the
 * queue, and the events of the workers (which have no access to the database). Job data holds
 * presigned URLs: it is never logged, and jobs are removed once their result is stored.
 */
@Injectable()
export class CompileQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(CompileQueueService.name);
  private readonly queue: Queue;
  private events: QueueEvents | null = null;

  constructor(
    private readonly config: ApiConfig,
    private readonly redis: RedisService,
  ) {
    this.queue = new Queue(COMPILE_QUEUE, {
      connection: { url: config.env.REDIS_URL, maxRetriesPerRequest: null },
    });
    this.queue.on('error', (error) => this.logger.error({ err: error.message }, 'Queue error'));
  }

  async add(data: QueuedJob, priority: number): Promise<void> {
    await this.queue.add('compile', data, {
      jobId: data.compilationId,
      priority,
      // A failed compilation is shown to the user, never retried behind their back.
      attempts: 1,
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 3600 },
    });
  }

  /** Removes a job that has not started. False when a worker already holds it. */
  async cancel(compilationId: string): Promise<boolean> {
    const job = await this.queue.getJob(compilationId);
    if (!job) return true;
    const state = await job.getState();
    if (state !== 'prioritized' && state !== 'waiting' && state !== 'delayed') return false;
    try {
      await job.remove();
      return true;
    } catch {
      return false;
    }
  }

  /** Forgets a finished job (its data holds expired URLs). */
  async forget(compilationId: string): Promise<void> {
    await this.queue.remove(compilationId).catch(() => undefined);
  }

  /** State and result of a job, to finish a compilation whose event was missed. */
  async status(
    compilationId: string,
  ): Promise<
    | { state: 'missing' }
    | { state: 'waiting' | 'active' }
    | { state: 'completed'; result: CompileResult | null }
    | { state: 'failed' }
  > {
    const job: Job | undefined = await this.queue.getJob(compilationId);
    if (!job) return { state: 'missing' };
    const state = await job.getState();
    if (state === 'completed') return { state, result: parseResult(job.returnvalue) };
    if (state === 'failed') return { state };
    if (state === 'active') return { state };
    return state === 'unknown' ? { state: 'missing' } : { state: 'waiting' };
  }

  /** Place in the queue (1 = next), among jobs of every priority, or null when not waiting. */
  async position(compilationId: string): Promise<number | null> {
    const rank = await this.redis.client.zrank(this.queue.toKey('prioritized'), compilationId);
    return rank === null ? null : rank + 1;
  }

  /**
   * Waiting jobs whose URLs were signed before `before`: their links would expire before a worker
   * takes them, so the API signs new ones (still GET, 5 minutes, one per file).
   */
  async stale(before: number): Promise<{ id: string; data: QueuedJob }[]> {
    const jobs = await this.queue.getJobs(['prioritized', 'waiting'], 0, 999);
    return jobs
      .filter((job): job is Job<QueuedJob> => Boolean(job?.id) && job.data.signedAt < before)
      .map((job) => ({ id: job.id!, data: job.data }));
  }

  async updateData(compilationId: string, data: QueuedJob): Promise<void> {
    const job = await this.queue.getJob(compilationId);
    const state = await job?.getState();
    if (job && (state === 'prioritized' || state === 'waiting')) await job.updateData(data);
  }

  /** Listens to the workers' events (started, finished, crashed). */
  listen(handlers: CompileEventHandlers): void {
    if (this.events) return;
    this.events = new QueueEvents(COMPILE_QUEUE, {
      connection: { url: this.config.env.REDIS_URL, maxRetriesPerRequest: null },
    });
    const run = (task: Promise<void>) =>
      task.catch((error: unknown) =>
        this.logger.error({ err: (error as Error).message }, 'Compile event failed'),
      );
    this.events.on('active', ({ jobId }) => void run(handlers.active(jobId)));
    this.events.on(
      'completed',
      ({ jobId, returnvalue }) => void run(handlers.completed(jobId, parseResult(returnvalue))),
    );
    this.events.on('failed', ({ jobId }) => void run(handlers.failed(jobId)));
    this.events.on('error', (error) => this.logger.error({ err: error.message }, 'Events error'));
  }

  async onModuleDestroy(): Promise<void> {
    await this.events?.close();
    await this.queue.close();
  }
}

/** URLs are renewed when they have been signed for more than half their validity. */
export const RENEW_URLS_AFTER_MS = (COMPILE_SOURCE_URL_SECONDS * 1000) / 2;

function parseResult(value: unknown): CompileResult | null {
  let data = value;
  if (typeof value === 'string') {
    try {
      data = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const parsed = compileResultSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}
