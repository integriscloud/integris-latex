import '../load-env.js';
import { type ApiEnv, apiEnvSchema, parseEnv } from '@integris/shared';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AuthModule } from '../auth/auth.module.js';
import { OriginGuard } from '../common/origin.guard.js';
import { ConfigModule, ApiConfig } from '../config/api-config.js';
import { configureApp } from '../configure-app.js';
import { MailModule } from '../mail/mail.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisModule } from '../redis/redis.module.js';
import { RedisService } from '../redis/redis.service.js';
import { SmsModule } from '../sms/sms.module.js';
import { FakePrisma } from './fake-prisma.js';

export const ORIGIN = 'http://127.0.0.1:3000';

/** Redis database reserved for tests (flushed by them): never the one used by `pnpm dev`. */
export function testRedisUrl(): string {
  const url = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  url.pathname = '/15';
  return url.toString();
}

export function testEnv(overrides: Record<string, string> = {}): ApiEnv {
  return parseEnv(apiEnvSchema, {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
    REDIS_URL: testRedisUrl(),
    AUTH_SECRET: 'test-auth-secret-0123456789abcdef0123',
    ALTCHA_HMAC_KEY: 'test-altcha-key-0123456789abcdef01234',
    // Cheap proof of work so tests solve challenges quickly.
    ALTCHA_KEY_PREFIX: '0',
    MINIO_API_ACCESS_KEY: 'unused',
    MINIO_API_SECRET_KEY: 'unused-in-tests',
    COLLAB_INTERNAL_SECRET: 'test-collab-internal-secret-0123456789abcdef',
    LIGDICASH_API_KEY: 'test-ligdicash-key',
    LIGDICASH_AUTH_TOKEN: 'test-ligdicash-token',
    LIGDICASH_API_URL: 'https://ligdicash.test',
    BILLING_SUPPORT_EMAIL: 'facturation@integris.test',
    ...overrides,
  });
}

export interface AuthTestApp {
  app: NestExpressApplication;
  prisma: FakePrisma;
  redis: RedisService;
  env: ApiEnv;
}

/** The auth API wired as in production, with a fake database and the test Redis database. */
export async function createAuthTestApp(
  overrides: Record<string, string> = {},
): Promise<AuthTestApp> {
  const env = testEnv(overrides);
  const prisma = new FakePrisma();
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule, PrismaModule, RedisModule, SmsModule, MailModule, AuthModule],
    providers: [{ provide: APP_GUARD, useClass: OriginGuard }],
  })
    .overrideProvider(ApiConfig)
    .useValue({ env })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app);
  await app.init();
  const redis = app.get(RedisService);
  await redis.client.flushdb();
  return { app, prisma, redis, env };
}

/** Solves a CAPTCHA challenge like the browser does and returns the payload to send. */
export async function solveCaptcha(
  app: NestExpressApplication,
  target: { action: string; phone?: string; dialCode?: string; email?: string },
  cookie?: string,
): Promise<string> {
  const { default: request } = await import('supertest');
  const { solveChallenge } = await import('altcha-lib');
  const { deriveKey } = await import('altcha-lib/algorithms/sha');
  const req = request(app.getHttpServer()).post('/api/auth/captcha').set('Origin', ORIGIN);
  if (cookie) req.set('Cookie', cookie);
  const challenge = (await req.send(target).expect(200)).body;
  const solution = await solveChallenge({ challenge, deriveKey });
  return Buffer.from(JSON.stringify({ challenge, solution })).toString('base64');
}
