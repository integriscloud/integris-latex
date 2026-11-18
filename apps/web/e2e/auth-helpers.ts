import { createPrismaClient } from '@integris/db';
import { Redis } from 'ioredis';
import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';

// The tests read the fake SMS and e-mails written to Redis by the API in development, and clean up
// the accounts they create. They run against latex-dev only, never production.
const rootEnv = new URL('../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
  lazyConnect: true,
});
const prisma = createPrismaClient(process.env.DATABASE_URL ?? '');

/** Numbers reserved for end-to-end tests: +226 79 99 xx xx. */
export const TEST_PHONE_PREFIX = '+2267999';

/** A test number unique to the project (desktop, mobile) and the test. */
export function testPhone(project: string, index: number): { local: string; e164: string } {
  const suffix = `${project === 'mobile' ? 5 : 1}${index}`.padStart(4, '0');
  const local = `79 99 ${suffix.slice(0, 2)} ${suffix.slice(2)}`;
  return { local, e164: `${TEST_PHONE_PREFIX}${suffix}` };
}

const keyed = (value: string) =>
  createHmac('sha256', process.env.AUTH_SECRET ?? '')
    .update(value)
    .digest('base64url');

/** Resets the anti-abuse counters of these identifiers and of the local IP. */
export async function resetLimits(identifiers: string[]): Promise<void> {
  const keys: string[] = [];
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const hash = keyed(ip);
    keys.push(`rl:send:ip:hour:${hash}`, `rl:send:ip:day:${hash}`, `rl:fail:ip:${hash}`);
  }
  for (const identifier of identifiers) {
    const hash = keyed(identifier);
    keys.push(
      `rl:send:id:15m:${hash}`,
      `rl:send:id:day:${hash}`,
      `rl:fail:id:${hash}`,
      `rl:lock:${hash}`,
      `otp:cooldown:${hash}`,
    );
  }
  await redis.del(...keys);
}

/** The code of the last fake SMS sent to a number. */
export async function lastSmsCode(e164: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const text = await redis.get(`dev:sms:${e164}`);
    const code = /\d{6}/.exec(text ?? '')?.[0];
    if (code) return code;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No SMS for ${e164}`);
}

/** The link in the last fake e-mail sent to an address. */
export async function lastMailLink(email: string): Promise<string> {
  const text = (await redis.get(`dev:mail:${email}`)) ?? '';
  const link = /https?:\/\/\S+#token=[\w-]+/.exec(text)?.[0];
  if (!link) throw new Error(`No e-mail link for ${email}`);
  return link;
}

export async function forgetMessages(e164: string, email?: string): Promise<void> {
  await redis.del(`dev:sms:${e164}`, ...(email ? [`dev:mail:${email}`] : []));
}

/** Deletes the accounts created by the tests (they own no other rows). */
export async function deleteTestUsers(phones: string[]): Promise<void> {
  await prisma.user.deleteMany({ where: { phone: { in: phones } } });
}

export async function closeHelpers(): Promise<void> {
  redis.disconnect();
  await prisma.$disconnect();
}
