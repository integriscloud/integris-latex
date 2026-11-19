import { createPrismaClient } from '@integris/db';
import { expect, type Page } from '@playwright/test';
import { Redis } from 'ioredis';
import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';

// The tests read the fake SMS and e-mails written to Redis by the API in development, and clean up
// the accounts they create. They run against latex-dev only, never production.
const rootEnv = new URL('../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

// Created on first use and again after closeHelpers(): a worker runs several spec files in turn,
// and each one closes the connections in its afterAll.
let redisClient: Redis | null = null;
let prismaClient: ReturnType<typeof createPrismaClient> | null = null;

const redis = () =>
  (redisClient ??= new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
    lazyConnect: true,
  }));
const prisma = () => (prismaClient ??= createPrismaClient(process.env.DATABASE_URL ?? ''));

/** Numbers reserved for end-to-end tests: +226 79 99 xx xx. */
export const TEST_PHONE_PREFIX = '+2267999';

/** First digit of the test numbers of each Playwright project (desktop otherwise). */
const PROJECT_DIGITS: Record<string, number> = { mobile: 5, 'chromium-120': 3 };

/** A test number unique to the project (desktop, mobile, chromium-120) and the test. */
export function testPhone(project: string, index: number): { local: string; e164: string } {
  const suffix = `${PROJECT_DIGITS[project] ?? 1}${index}`.padStart(4, '0');
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
  await redis().del(...keys);
}

/** The code of the last fake SMS sent to a number. */
export async function lastSmsCode(e164: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const text = await redis().get(`dev:sms:${e164}`);
    const code = /\d{6}/.exec(text ?? '')?.[0];
    if (code) return code;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No SMS for ${e164}`);
}

/** The link in the last fake e-mail sent to an address. */
export async function lastMailLink(email: string): Promise<string> {
  const text = (await redis().get(`dev:mail:${email}`)) ?? '';
  const link = /https?:\/\/\S+#token=[\w-]+/.exec(text)?.[0];
  if (!link) throw new Error(`No e-mail link for ${email}`);
  return link;
}

export async function forgetMessages(e164: string, email?: string): Promise<void> {
  await redis().del(`dev:sms:${e164}`, ...(email ? [`dev:mail:${email}`] : []));
}

/**
 * Deletes the accounts created by the tests. Their projects are erased through the API by the
 * tests themselves (see eraseAllProjects); rows left by a failed test are removed here.
 */
export async function deleteTestUsers(phones: string[]): Promise<void> {
  const owner = { owner: { phone: { in: phones } } };
  await prisma().projectMember.deleteMany({
    where: { OR: [{ project: owner }, { user: { phone: { in: phones } } }] },
  });
  await prisma().projectVersion.deleteMany({ where: { project: owner } });
  await prisma().projectFile.deleteMany({ where: { project: owner } });
  await prisma().compilation.deleteMany({ where: { project: owner } });
  await prisma().project.deleteMany({ where: owner });
  await prisma().user.deleteMany({ where: { phone: { in: phones } } });
}

/** Types a code in the digit boxes (paste spreads it across the boxes). */
export async function enterCode(page: Page, code: string) {
  await page.getByRole('textbox', { name: 'Chiffre 1 sur 6' }).fill(code);
}

/** Creates an account through the sign-up form and opens its space. */
export async function signUp(page: Page, phone: { local: string; e164: string }, email?: string) {
  await deleteTestUsers([phone.e164]);
  await forgetMessages(phone.e164);
  await resetLimits([phone.e164]);

  await page.goto('/fr/signup');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Créer un compte');
  await page.getByLabel('Prénom').fill('Awa');
  await page.getByLabel('Nom', { exact: true }).fill('Kaboré');
  await page.getByLabel('Numéro de téléphone').fill(phone.local);
  if (email) await page.getByLabel('E-mail').fill(email);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Recevoir le code par SMS' }).click();

  await expect(page.getByText('Étape 2 sur 3 · Vérification du numéro')).toBeVisible();
  await enterCode(page, await lastSmsCode(phone.e164));
  await page.getByRole('button', { name: 'Créer mon compte' }).click();
  await expect(page.getByText('Votre compte est créé.')).toBeVisible();
  await page.getByRole('link', { name: 'Ouvrir mon espace' }).click();
  // A new account only has the personal space: the space chooser is skipped.
  await expect(page).toHaveURL(/\/fr\/app$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bonjour Awa');
}

/** Erases every project of the signed-in user through the API (objects included). */
export async function eraseAllProjects(page: Page): Promise<void> {
  const headers = { origin: new URL(page.url()).origin, 'content-type': 'application/json' };
  for (const view of ['active', 'trash']) {
    const response = await page.request.get(`/api/projects?view=${view}`);
    const { projects } = (await response.json()) as { projects: { id: string; role: string }[] };
    for (const project of projects.filter((item) => item.role === 'OWNER')) {
      if (view === 'active') {
        await page.request.post(`/api/projects/${project.id}/trash`, { headers, data: {} });
      }
      await page.request.delete(`/api/projects/${project.id}`, { headers, data: {} });
    }
  }
}

/**
 * Gives an account a role on a project, as sharing will at step 8, and asks the collaboration
 * server to check the open connections again. No audit entry: the dev database keeps none for
 * tests.
 */
export async function shareProject(
  projectId: string,
  phone: string,
  role: 'EDITOR' | 'SUPERVISOR' | 'REVIEWER' | 'VIEWER',
): Promise<void> {
  const user = await prisma().user.findUniqueOrThrow({ where: { phone } });
  await prisma().projectMember.upsert({
    where: { projectId_userId: { projectId, userId: user.id } },
    create: { projectId, userId: user.id, role },
    update: { role },
  });
  await redis().publish('collab:events', JSON.stringify({ type: 'project-access', projectId }));
}

export async function closeHelpers(): Promise<void> {
  redisClient?.disconnect();
  await prismaClient?.$disconnect();
  redisClient = null;
  prismaClient = null;
}
