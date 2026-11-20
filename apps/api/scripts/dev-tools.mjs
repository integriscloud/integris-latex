// Development tools for testing with several accounts on latex-dev (never in production).
//   pnpm dev:share <project id or name> <phone> [EDITOR|SUPERVISOR|REVIEWER|VIEWER|remove]
//   pnpm dev:otp <phone>
//   pnpm dev:plan <phone> [FREE|STANDARD|TEAM|BUSINESS] [--lapsed]
//   pnpm dev:pay [<payment id or phone>] [completed|notcompleted|pending] [--twice]
// Sharing is done in the app since step 8 (invitation accepted by the invitee). This tool stays
// for tests: it gives an account a role at once, without invitation nor audit entry. The account
// is created when the phone number has none (sign-in by SMS code, the code being read with
// dev:otp since SMS are only written to the logs on latex-dev).
// dev:plan gives an account a plan without payment: it ends the personal subscriptions (paid ones
// too) and the seats given by this tool before, then creates a personal STANDARD subscription or
// a seat in a test TEAM/BUSINESS organization, for 30 days. FREE only ends them. --lapsed creates the
// subscription with its period and grace already over (the end of a subscription by its dates).
// The running API (pnpm dev) then applies the plan's limits (read-only projects) at once.
// dev:pay settles a payment of the simulated LigdiCash (PAYMENT_PROVIDER=simulated): it sets the
// outcome the simulated status API answers, then calls the API callback like LigdiCash (JSON then
// form); --twice sends them twice (idempotency). Without argument: the pending payments. The API
// still checks the status itself before activating, as with LigdiCash.
import { createPrismaClient } from '@integris/db';
import {
  COLLAB_EVENTS_CHANNEL,
  COLLAB_SECRET_HEADER,
  INTERNAL_PATHS,
  normalizePhone,
  PORTS,
  SUBSCRIPTION_GRACE_DAYS,
} from '@integris/shared';
import { Redis } from 'ioredis';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

if (process.env.NODE_ENV === 'production' || process.env.SMS_PROVIDER !== 'log') {
  console.error('Development tool: refused outside latex-dev (NODE_ENV, SMS_PROVIDER=log).');
  process.exit(1);
}

const ROLES = ['EDITOR', 'SUPERVISOR', 'REVIEWER', 'VIEWER'];
const [command, ...args] = process.argv.slice(2);

/** Phone typed as in the app ("70 00 00 01"), Burkina Faso by default. */
function phoneOf(input) {
  const phone = normalizePhone(input ?? '', '226');
  if (!phone) {
    console.error(`Invalid phone number: ${input ?? '(none)'}`);
    process.exit(1);
  }
  return phone;
}

async function share() {
  const [projectInput, phoneInput, roleInput = 'EDITOR'] = args;
  const prisma = createPrismaClient(process.env.DATABASE_URL);
  try {
    if (!projectInput || !phoneInput) {
      const recent = await prisma.project.findMany({
        where: { deletedAt: null },
        orderBy: { lastActivityAt: 'desc' },
        take: 10,
        include: { owner: { select: { displayName: true, phone: true } } },
      });
      console.log('Usage: pnpm dev:share <project id or name> <phone> [role|remove]\n');
      console.log('Recent projects:');
      for (const project of recent) {
        console.log(
          `  ${project.id}  ${project.name}  (owner ${project.owner.displayName}, ${project.owner.phone ?? '-'})`,
        );
      }
      return;
    }
    const role = roleInput.toUpperCase();
    if (role !== 'REMOVE' && !ROLES.includes(role)) {
      console.error(`Role must be one of ${ROLES.join(', ')} or remove.`);
      process.exitCode = 1;
      return;
    }
    const matches = await prisma.project.findMany({
      where: {
        deletedAt: null,
        OR: [{ id: projectInput }, { name: { equals: projectInput, mode: 'insensitive' } }],
      },
    });
    if (matches.length !== 1) {
      console.error(
        matches.length
          ? `Several projects are named "${projectInput}": use the id (${matches.map((p) => p.id).join(', ')}).`
          : `No project "${projectInput}" (id or exact name).`,
      );
      process.exitCode = 1;
      return;
    }
    const [project] = matches;
    const phone = phoneOf(phoneInput);
    let user = await prisma.user.findUnique({ where: { phone } });
    if (role === 'REMOVE') {
      if (user)
        await prisma.projectMember.deleteMany({
          where: { projectId: project.id, userId: user.id },
        });
    } else {
      if (!user) {
        user = await prisma.user.create({
          data: {
            phone,
            phoneVerifiedAt: new Date(),
            displayName: `Compte test ${phone.slice(-2)}`,
          },
        });
        console.log(`Account created: ${phone} ("${user.displayName}", sign in with an SMS code).`);
      }
      if (user.id === project.ownerId) {
        console.error('This account owns the project.');
        process.exitCode = 1;
        return;
      }
      await prisma.projectMember.upsert({
        where: { projectId_userId: { projectId: project.id, userId: user.id } },
        create: { projectId: project.id, userId: user.id, role },
        update: { role },
      });
    }
    if (user) {
      await prisma.auditLog.create({
        data: {
          actorId: project.ownerId,
          action: role === 'REMOVE' ? 'PROJECT_UNSHARED' : 'PROJECT_SHARED',
          targetType: 'Project',
          targetId: project.id,
          metadata: { userId: user.id, role, via: 'dev-tools' },
        },
      });
    }
    // Open editors check their rights again at once.
    const redis = new Redis(process.env.REDIS_URL);
    await redis.publish(
      COLLAB_EVENTS_CHANNEL,
      JSON.stringify({ type: 'project-access', projectId: project.id }),
    );
    await redis.quit();
    console.log(
      role === 'REMOVE'
        ? `${phone} removed from "${project.name}".`
        : `${phone} is ${role} on "${project.name}" (${project.id}).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function otp() {
  const phone = phoneOf(args[0]);
  const redis = new Redis(process.env.REDIS_URL);
  const text = await redis.get(`dev:sms:${phone}`);
  await redis.quit();
  console.log(text ?? `No SMS sent to ${phone} in the last 10 minutes.`);
}

const PLANS = ['FREE', 'STANDARD', 'TEAM', 'BUSINESS'];
const DEV_ORG_PREFIX = '[dev:plan] ';
const DAY_MS = 86_400_000;

async function plan() {
  const positional = args.filter((arg) => !arg.startsWith('--'));
  const lapsed = args.includes('--lapsed');
  const [phoneInput, planInput] = positional;
  if (!phoneInput) {
    console.error('Usage: pnpm dev:plan <phone> [FREE|STANDARD|TEAM|BUSINESS] [--lapsed]');
    process.exitCode = 1;
    return;
  }
  const code = planInput?.toUpperCase();
  if (code && !PLANS.includes(code)) {
    console.error(`Plan must be one of ${PLANS.join(', ')}.`);
    process.exitCode = 1;
    return;
  }
  const phone = phoneOf(phoneInput);
  const prisma = createPrismaClient(process.env.DATABASE_URL);
  try {
    const user = await prisma.user.findUnique({ where: { phone } });
    if (!user) {
      console.error(`No account for ${phone} (sign up in the app first).`);
      process.exitCode = 1;
      return;
    }
    if (code) {
      await setPlan(prisma, user, code, lapsed);
      const changed = await applyLimits(user.id);
      console.log(
        (code === 'FREE'
          ? `${phone} now holds FREE only (subscriptions and seats from dev:plan ended).`
          : `${phone} now holds ${code}${lapsed ? ' (lapsed: period and grace over)' : ' for 30 days'}.`) +
          (changed === null
            ? ' The API did not answer: limits will apply within 10 minutes (or on the next trash).'
            : ` Projects switched (read-only ⇄ writable): ${changed}.`),
      );
    }
    await show(prisma, user);
  } finally {
    await prisma.$disconnect();
  }
}

async function setPlan(prisma, user, code, lapsed) {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    // Every personal subscription ends now, paid ones included (a test tool).
    await tx.subscription.updateMany({
      where: { userId: user.id, status: { in: ['TRIALING', 'ACTIVE', 'GRACE', 'PAUSED'] } },
      data: { status: 'CANCELED' },
    });
    const devSeats = await tx.seat.findMany({
      where: {
        userId: user.id,
        releasedAt: null,
        subscription: { organization: { name: { startsWith: DEV_ORG_PREFIX } } },
      },
      select: { id: true, subscriptionId: true },
    });
    for (const seat of devSeats) {
      await tx.seat.update({ where: { id: seat.id }, data: { releasedAt: now } });
      await tx.subscription.update({
        where: { id: seat.subscriptionId },
        data: { status: 'CANCELED' },
      });
    }
    if (code === 'FREE') return;
    const planRow = await tx.plan.findUniqueOrThrow({ where: { code } });
    const periodEnd = lapsed
      ? new Date(now.getTime() - (SUBSCRIPTION_GRACE_DAYS + 1) * DAY_MS)
      : new Date(now.getTime() + 30 * DAY_MS);
    const dates = {
      status: 'ACTIVE',
      billingPeriod: 'MONTHLY',
      currentPeriodStart: new Date(periodEnd.getTime() - 30 * DAY_MS),
      currentPeriodEnd: periodEnd,
    };
    if (code === 'STANDARD') {
      await tx.subscription.create({ data: { planId: planRow.id, userId: user.id, ...dates } });
    } else {
      const organization = await tx.organization.create({
        data: { type: code, name: `${DEV_ORG_PREFIX}${code} ${user.phone}` },
      });
      const subscription = await tx.subscription.create({
        data: {
          planId: planRow.id,
          organizationId: organization.id,
          seatCount: planRow.minSeats,
          ...dates,
        },
      });
      await tx.seat.create({
        data: { subscriptionId: subscription.id, userId: user.id, assignedAt: now },
      });
    }
    // Seats and plans are audited; no actor (a tool), so test accounts stay erasable.
    await tx.auditLog.create({
      data: {
        actorId: null,
        action: 'DEV_PLAN_SET',
        targetType: 'User',
        targetId: user.id,
        metadata: { plan: code, lapsed, via: 'dev-tools' },
      },
    });
  });
}

/** Asks the running API to apply the plan's limits; null when it does not answer. */
async function applyLimits(userId) {
  try {
    const response = await fetch(
      `http://127.0.0.1:${PORTS.internal}${INTERNAL_PATHS.planChanged}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [COLLAB_SECRET_HEADER]: process.env.COLLAB_INTERNAL_SECRET ?? '',
        },
        body: JSON.stringify({ userIds: [userId] }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) return null;
    const { changed } = await response.json();
    return changed[userId]?.length ?? 0;
  } catch {
    return null;
  }
}

async function show(prisma, user) {
  const now = new Date();
  const [subscriptions, seats, projects] = await Promise.all([
    prisma.subscription.findMany({
      where: { userId: user.id, status: { in: ['TRIALING', 'ACTIVE', 'GRACE'] } },
      include: { plan: true },
    }),
    prisma.seat.findMany({
      where: { userId: user.id, releasedAt: null },
      include: { subscription: { include: { plan: true, organization: true } } },
    }),
    prisma.project.findMany({
      where: { ownerId: user.id, deletedAt: null },
      orderBy: { lastActivityAt: 'desc' },
      select: { name: true, readOnlyReason: true },
    }),
  ]);
  const until = (s) =>
    s.graceEndsAt ?? new Date(s.currentPeriodEnd.getTime() + SUBSCRIPTION_GRACE_DAYS * DAY_MS);
  console.log(`\n${user.displayName} (${user.phone}):`);
  console.log('  FREE (always)');
  for (const s of subscriptions) {
    console.log(
      `  ${s.plan.code} personal, ${s.status}, applies until ${until(s).toISOString()}${until(s) <= now ? ' (lapsed)' : ''}`,
    );
  }
  for (const seat of seats) {
    const s = seat.subscription;
    if (!['TRIALING', 'ACTIVE', 'GRACE'].includes(s.status)) continue;
    console.log(
      `  ${s.plan.code} seat in "${s.organization?.name ?? '-'}", ${s.status}, applies until ${until(s).toISOString()}${until(s) <= now ? ' (lapsed)' : ''}`,
    );
  }
  console.log(`  Projects (${projects.length}):`);
  for (const p of projects)
    console.log(`    ${p.readOnlyReason ? 'read-only' : 'writable '}  ${p.name}`);
}

const OUTCOMES = ['completed', 'notcompleted', 'pending'];

async function pay() {
  if (process.env.PAYMENT_PROVIDER !== 'simulated') {
    console.error('dev:pay needs PAYMENT_PROVIDER=simulated in .env (then restart pnpm dev).');
    process.exitCode = 1;
    return;
  }
  const positional = args.filter((arg) => !arg.startsWith('--'));
  const twice = args.includes('--twice');
  const [target, outcomeInput = 'completed'] = positional;
  if (!OUTCOMES.includes(outcomeInput)) {
    console.error(`Outcome must be one of ${OUTCOMES.join(', ')}.`);
    process.exitCode = 1;
    return;
  }
  const prisma = createPrismaClient(process.env.DATABASE_URL);
  const redis = new Redis(process.env.REDIS_URL);
  try {
    if (!target) {
      const pending = await prisma.payment.findMany({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { user: { select: { phone: true } } },
      });
      console.log(
        'Usage: pnpm dev:pay <payment id or phone> [completed|notcompleted|pending] [--twice]\n',
      );
      console.log('Pending payments:');
      for (const p of pending) {
        console.log(
          `  ${p.id}  ${p.amountXof} FCFA  ${p.purpose} ${p.planCode}  (${p.user.phone ?? '-'})`,
        );
      }
      return;
    }
    const byPhone = /^\+?[\d ]{8,}$/.test(target);
    const payment = byPhone
      ? await prisma.payment.findFirst({
          where: { user: { phone: phoneOf(target) }, providerToken: { not: null } },
          orderBy: { createdAt: 'desc' },
        })
      : await prisma.payment.findUnique({ where: { id: target } });
    if (!payment?.providerToken?.startsWith('sim_')) {
      console.error('No payment of the simulated LigdiCash found (pay from the app first).');
      process.exitCode = 1;
      return;
    }
    const key = `dev:pay:${payment.providerToken}`;
    const stored = await redis.get(key);
    if (!stored) {
      console.error('Simulated invoice expired (7 days).');
      process.exitCode = 1;
      return;
    }
    await redis.set(
      key,
      JSON.stringify({ ...JSON.parse(stored), status: outcomeInput }),
      'KEEPTTL',
    );
    const url = `http://127.0.0.1:${PORTS.api}/api/payments/ligdicash/callback`;
    const customData = [{ keyof_customdata: 'transaction_id', valueof_customdata: payment.id }];
    const form = new URLSearchParams({
      status: outcomeInput,
      'custom_data[0][keyof_customdata]': 'transaction_id',
      'custom_data[0][valueof_customdata]': payment.id,
    });
    for (let round = 0; round < (twice ? 2 : 1); round++) {
      for (const [type, body] of [
        ['application/json', JSON.stringify({ status: outcomeInput, custom_data: customData })],
        ['application/x-www-form-urlencoded', form.toString()],
      ]) {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': type },
          body,
        });
        console.log(`Callback (${type}): ${response.status}`);
      }
    }
    const after = await prisma.payment.findUnique({
      where: { id: payment.id },
      include: { receipt: { select: { number: true } } },
    });
    console.log(
      `Payment ${after.id}: ${after.status}${after.duplicateReason ? ` (${after.duplicateReason})` : ''}` +
        `${after.receipt ? `, receipt no. ${String(after.receipt.number).padStart(6, '0')}` : ''}.`,
    );
  } finally {
    await prisma.$disconnect();
    await redis.quit();
  }
}

if (command === 'share') await share();
else if (command === 'otp') await otp();
else if (command === 'plan') await plan();
else if (command === 'pay') await pay();
else {
  console.error('Commands: share, otp, plan, pay');
  process.exitCode = 1;
}
