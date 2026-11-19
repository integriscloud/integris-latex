import type { CompileResult } from '@integris/shared';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { CanActivate, ExecutionContext, Type } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AuthGuard } from '../auth/auth.guard.js';
import { OriginGuard } from '../common/origin.guard.js';
import {
  type CompileEventHandlers,
  CompileQueueService,
  type QueuedJob,
} from '../compile/compile-queue.service.js';
import { CompileModule } from '../compile/compile.module.js';
import { ApiConfig, ConfigModule } from '../config/api-config.js';
import { configureApp } from '../configure-app.js';
import { MailModule } from '../mail/mail.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisModule } from '../redis/redis.module.js';
import { RedisService } from '../redis/redis.service.js';
import { SmsModule } from '../sms/sms.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { StorageService } from '../storage/storage.service.js';
import { testEnv } from './auth-app.js';
import { FakeProjectsDb, FakeStorage } from './fake-projects-db.js';
import { TEST_USER_HEADER } from './projects-app.js';

/** In-memory BullMQ queue: jobs, their state and the workers' events. */
export class FakeQueue {
  jobs = new Map<
    string,
    { data: QueuedJob; priority: number; state: string; result?: CompileResult }
  >();
  handlers: CompileEventHandlers | null = null;

  reset(): void {
    this.jobs.clear();
  }
  async add(data: QueuedJob, priority: number): Promise<void> {
    this.jobs.set(data.compilationId, { data, priority, state: 'prioritized' });
  }
  async cancel(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (job && job.state !== 'prioritized') return false;
    this.jobs.delete(id);
    return true;
  }
  async forget(id: string): Promise<void> {
    this.jobs.delete(id);
  }
  async status(id: string) {
    const job = this.jobs.get(id);
    if (!job) return { state: 'missing' as const };
    if (job.state === 'completed')
      return { state: 'completed' as const, result: job.result ?? null };
    if (job.state === 'active') return { state: 'active' as const };
    return { state: 'waiting' as const };
  }
  async position(id: string): Promise<number | null> {
    const waiting = [...this.jobs.values()]
      .filter((job) => job.state === 'prioritized')
      .sort((a, b) => a.priority - b.priority);
    const index = waiting.findIndex((job) => job.data.compilationId === id);
    return index === -1 ? null : index + 1;
  }
  async stale(before: number) {
    return [...this.jobs.values()]
      .filter((job) => job.state === 'prioritized' && job.data.signedAt < before)
      .map((job) => ({ id: job.data.compilationId, data: job.data }));
  }
  async updateData(id: string, data: QueuedJob): Promise<void> {
    const job = this.jobs.get(id);
    if (job) job.data = data;
  }
  listen(handlers: CompileEventHandlers): void {
    this.handlers = handlers;
  }
}

export interface CompileTestApp {
  app: NestExpressApplication;
  db: FakeProjectsDb;
  storage: FakeStorage;
  queue: FakeQueue;
}

/** The compile API wired as in production, with fakes for the database, storage and queue. */
export async function createCompileTestApp(
  overrides: Record<string, string> = {},
  modules: Type[] = [],
): Promise<CompileTestApp> {
  const env = testEnv(overrides);
  const db = new FakeProjectsDb();
  const storage = new FakeStorage();
  const queue = new FakeQueue();
  const fakeAuth: CanActivate = {
    canActivate(context: ExecutionContext) {
      const request = context.switchToHttp().getRequest();
      const user = db.users.find((item) => item.id === request.get(TEST_USER_HEADER));
      if (!user) return false;
      request.auth = { user };
      return true;
    },
  };
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule,
      PrismaModule,
      RedisModule,
      StorageModule,
      SmsModule,
      MailModule,
      CompileModule,
      ...modules,
    ],
    providers: [{ provide: APP_GUARD, useClass: OriginGuard }],
  })
    .overrideProvider(ApiConfig)
    .useValue({ env })
    .overrideProvider(PrismaService)
    .useValue(db)
    .overrideProvider(StorageService)
    .useValue(storage)
    .overrideProvider(CompileQueueService)
    .useValue(queue)
    .overrideGuard(AuthGuard)
    .useValue(fakeAuth)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app);
  await app.init();
  await app.get(RedisService).client.flushdb();
  return { app, db, storage, queue };
}
