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
  const users = { phone: { in: phones } };
  await prisma().commentReply.deleteMany({
    where: { OR: [{ comment: { project: owner } }, { author: users }] },
  });
  await prisma().comment.deleteMany({ where: { OR: [{ project: owner }, { author: users }] } });
  await prisma().projectInvitation.deleteMany({ where: { project: owner } });
  await prisma().shareLinkOpening.deleteMany({ where: { link: { project: owner } } });
  await prisma().shareLink.deleteMany({ where: { project: owner } });
  await prisma().projectMember.deleteMany({
    where: { OR: [{ project: owner }, { user: users }] },
  });
  await prisma().compilation.deleteMany({ where: { project: owner } });
  await prisma().submissionVersion.deleteMany({ where: { submission: { project: owner } } });
  await prisma().submissionReviewer.deleteMany({ where: { submission: { project: owner } } });
  await prisma().submission.deleteMany({ where: { project: owner } });
  await prisma().projectVersion.deleteMany({ where: { project: owner } });
  await prisma().projectFile.deleteMany({ where: { project: owner } });
  await prisma().projectFolder.deleteMany({ where: { project: owner } });
  await prisma().compilation.deleteMany({ where: { project: owner } });
  await prisma().project.deleteMany({ where: owner });
  await prisma().usageCounter.deleteMany({ where: { user: users } });
  await prisma().notification.deleteMany({ where: { user: users } });
  // Plans given by `pnpm dev:plan`: personal subscriptions, and seats in test organizations.
  const devOrganizations = await prisma().organization.findMany({
    where: {
      name: { startsWith: '[dev:plan] ' },
      subscription: { seats: { some: { user: users } } },
    },
    select: { id: true },
  });
  const devSubscriptions = { organizationId: { in: devOrganizations.map((org) => org.id) } };
  await prisma().seat.deleteMany({
    where: { OR: [{ user: users }, { subscription: devSubscriptions }] },
  });
  await prisma().subscription.deleteMany({ where: { OR: [{ user: users }, devSubscriptions] } });
  await prisma().organization.deleteMany({
    where: { id: { in: devOrganizations.map((org) => org.id) } },
  });
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
 * Gives an account a role on a project at once (like `pnpm dev:share`), and asks the
 * collaboration server to check the open connections again. No invitation and no audit entry:
 * an account with audit entries can no longer be deleted (append-only table).
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

/**
 * Signs in with an account kept between runs (created on first use). The sharing tests use
 * them: sharing writes append-only audit entries, after which an account can no longer be
 * deleted. Their projects are erased by the tests (eraseAllProjects).
 */
export async function signInKept(page: Page, phone: { local: string; e164: string }) {
  const existing = await prisma().user.findUnique({ where: { phone: phone.e164 } });
  if (!existing) {
    await signUp(page, phone);
    return;
  }
  await forgetMessages(phone.e164);
  await resetLimits([phone.e164]);
  await page.goto('/fr/login');
  await page.getByLabel('Numéro de téléphone').fill(phone.local);
  await page.getByRole('button', { name: 'Recevoir le code' }).click();
  await enterCode(page, await lastSmsCode(phone.e164));
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await expect(page).toHaveURL(/\/fr\/(app|spaces)$/);
}

/** The link of the last fake SMS sent to a number (an invitation). */
export async function lastSmsLink(e164: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const link = /https?:\/\/\S+#token=[\w-]{43}/.exec(
      (await redis().get(`dev:sms:${e164}`)) ?? '',
    );
    if (link) return link[0];
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No invitation SMS for ${e164}`);
}

/** Pending invitations and public links of the projects of these accounts (left by a failure). */
export async function forgetInvitations(phones: string[]): Promise<void> {
  await prisma().projectInvitation.updateMany({
    where: { phone: { in: phones }, status: 'PENDING' },
    data: { status: 'REVOKED' },
  });
}

/**
 * Billing tests (step 11) use kept accounts: payments, credits and audit entries are append-only
 * or point to the payer. Before each run, their subscriptions end, their seats are released and
 * the trial is available again, their credit balance is zero; a verified e-mail is set.
 */
export async function resetBillingAccount(e164: string, email: string): Promise<void> {
  const user = await prisma().user.findUnique({ where: { phone: e164 } });
  if (!user) return;
  const owned = await prisma().membership.findMany({
    where: { userId: user.id, role: 'OWNER' },
    select: { organizationId: true },
  });
  const organizations = owned.map((row) => row.organizationId);
  await prisma().subscription.updateMany({
    where: { OR: [{ userId: user.id }, { organizationId: { in: organizations } }] },
    data: { status: 'CANCELED', pendingPlanId: null },
  });
  await prisma().seat.updateMany({
    where: { userId: user.id, releasedAt: null },
    data: { releasedAt: new Date() },
  });
  await prisma().notification.deleteMany({ where: { userId: user.id } });
  // Credit left by earlier runs: the ledger is append-only, so an entry brings it back to zero.
  const credit = await prisma().creditEntry.aggregate({
    where: { userId: user.id },
    _sum: { amountXof: true },
  });
  const balance = credit._sum.amountXof ?? 0;
  if (balance > 0) {
    await prisma().creditEntry.create({
      data: { userId: user.id, amountXof: -balance, reason: 'REFUNDED' },
    });
  }
  await prisma().user.update({
    where: { id: user.id },
    data: { email, emailVerifiedAt: new Date(), trialUsedAt: null },
  });
  await redis().del(`dev:mail:${email}`, `dev:mail-attachments:${email}`);
}

/** Names and sizes of the files of the last e-mail with attachments sent to an address. */
export async function lastMailAttachments(
  email: string,
): Promise<{ filename: string; size: number }[]> {
  return JSON.parse((await redis().get(`dev:mail-attachments:${email}`)) ?? '[]');
}

/** Name prefix of the organizations bought by the end-to-end tests (step 12). */
export const E2E_ORG_PREFIX = '[e2e] ';

/**
 * Organization tests (step 12) use kept accounts (seats, roles and links are audited). Before each
 * run: the test organizations they own are deleted with their seats, invitations, imports,
 * groups and supervision links; their other memberships, join requests, projects and
 * notifications go; each gets the given display name.
 */
export async function resetOrganizationAccounts(
  accounts: { e164: string; name: string }[],
): Promise<void> {
  const db = prisma();
  const phones = accounts.map((account) => account.e164);
  const users = await db.user.findMany({ where: { phone: { in: phones } } });
  const userIds = users.map((user) => user.id);
  const organizations = await db.organization.findMany({
    where: {
      name: { startsWith: E2E_ORG_PREFIX },
      memberships: { some: { userId: { in: userIds }, role: 'OWNER' } },
    },
    select: { id: true },
  });
  const orgIds = organizations.map((org) => org.id);
  const links = await db.supervision.findMany({
    where: {
      OR: [
        { organizationId: { in: orgIds } },
        { supervisorId: { in: userIds } },
        { studentId: { in: userIds } },
      ],
    },
    select: { id: true },
  });
  const linkIds = links.map((link) => link.id);
  await db.projectMember.deleteMany({
    where: {
      OR: [{ viaSupervisionId: { in: linkIds } }, { project: { ownerId: { in: userIds } } }],
    },
  });
  await db.supervision.deleteMany({ where: { id: { in: linkIds } } });
  const subscriptions = await db.subscription.findMany({
    where: { organizationId: { in: orgIds } },
    select: { id: true },
  });
  const subscriptionIds = subscriptions.map((row) => row.id);
  // Seats held elsewhere are released (they are never deleted outside the test organizations).
  await db.seat.updateMany({
    where: {
      userId: { in: userIds },
      releasedAt: null,
      subscriptionId: { notIn: subscriptionIds },
    },
    data: { releasedAt: new Date() },
  });
  await db.seat.deleteMany({ where: { subscriptionId: { in: subscriptionIds } } });
  await db.payment.updateMany({
    where: { subscriptionId: { in: subscriptionIds } },
    data: { subscriptionId: null },
  });
  await db.subscription.deleteMany({ where: { id: { in: subscriptionIds } } });
  await db.invitation.deleteMany({
    where: { OR: [{ organizationId: { in: orgIds } }, { phone: { in: phones } }] },
  });
  await db.userImport.deleteMany({ where: { organizationId: { in: orgIds } } });
  await db.membership.deleteMany({
    where: { OR: [{ organizationId: { in: orgIds } }, { userId: { in: userIds } }] },
  });
  await db.orgGroup.deleteMany({ where: { organizationId: { in: orgIds } } });
  await db.organization.deleteMany({ where: { id: { in: orgIds } } });
  await db.project.deleteMany({ where: { ownerId: { in: userIds } } });
  await db.notification.deleteMany({ where: { userId: { in: userIds } } });
  for (const account of accounts) {
    await db.user.updateMany({
      where: { phone: account.e164 },
      data: { displayName: account.name, lastSpace: null },
    });
  }
}

/**
 * A credit balance that pays a monthly BUSINESS of `seats` seats (price read from the Plan
 * table): the order is then activated without LigdiCash, like any order covered by credit.
 */
export async function creditForBusiness(e164: string, seats: number): Promise<void> {
  const user = await prisma().user.findUniqueOrThrow({ where: { phone: e164 } });
  const plan = await prisma().plan.findUniqueOrThrow({ where: { code: 'BUSINESS' } });
  await prisma().creditEntry.create({
    data: { userId: user.id, amountXof: plan.priceMonthlyXof * seats, reason: 'PRORATION_SURPLUS' },
  });
}

/** A bare project of an account (no file): enough to be listed and opened to a supervisor. */
export async function createBareProject(e164: string, name: string): Promise<string> {
  const user = await prisma().user.findUniqueOrThrow({ where: { phone: e164 } });
  const project = await prisma().project.create({ data: { ownerId: user.id, name } });
  return project.id;
}
