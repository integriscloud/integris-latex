import '../load-env.js';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type CanActivate, type ExecutionContext, type Type } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AuthGuard } from '../auth/auth.guard.js';
import { OriginGuard } from '../common/origin.guard.js';
import { ApiConfig, ConfigModule } from '../config/api-config.js';
import { configureApp } from '../configure-app.js';
import { MailModule } from '../mail/mail.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { RedisModule } from '../redis/redis.module.js';
import { RedisService } from '../redis/redis.service.js';
import { SmsModule } from '../sms/sms.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { StorageService } from '../storage/storage.service.js';
import { testEnv } from './auth-app.js';
import { FakeProjectsDb, FakeStorage } from './fake-projects-db.js';

/** Header naming the signed-in test user (the session itself is covered by the auth tests). */
export const TEST_USER_HEADER = 'x-test-user';

export interface ProjectsTestApp {
  app: NestExpressApplication;
  db: FakeProjectsDb;
  storage: FakeStorage;
}

/** The projects API wired as in production, with a fake database and a fake object storage. */
export async function createProjectsTestApp(
  overrides: Record<string, string> = {},
  modules: Type[] = [],
): Promise<ProjectsTestApp> {
  const env = testEnv(overrides);
  const db = new FakeProjectsDb();
  const storage = new FakeStorage();
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
      ProjectsModule,
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
    .overrideGuard(AuthGuard)
    .useValue(fakeAuth)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app);
  await app.init();
  await app.get(RedisService).client.flushdb();
  return { app, db, storage };
}
