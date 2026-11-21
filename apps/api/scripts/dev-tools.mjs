// Development tools for testing with several accounts on latex-dev (never in production).
//   pnpm dev:share <project id or name> <phone> [EDITOR|SUPERVISOR|REVIEWER|VIEWER|remove]
//   pnpm dev:otp <phone>
//   pnpm dev:plan <phone> [FREE|STANDARD|TEAM|BUSINESS] [--lapsed]
//   pnpm dev:pay [<payment id or phone>] [completed|notcompleted|pending] [--twice]
//   pnpm dev:org [--reset]
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
// dev:org creates a test BUSINESS of 11 seats, without payment, with fixed test accounts
// (+226 79 98 00 00 to 10): the owner, an admin, two teachers, five students in two groups, a
// secretariat serving the UFR SVT (step 13), one free seat, a teacher's join request waiting for
// an admin, two assigned supervision links and a student's request. --reset deletes it first (and
// its seats, links and invitations); an organization with print requests, whose journal is
// append-only, is renamed "[dev:org archived]" and emptied instead.
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

const DEV_ORG_NAME = '[dev:org] Université de test';
const DEV_ORG_ACCOUNTS = [
  { name: 'Titulaire Test', role: 'OWNER', kind: 'OTHER' },
  { name: 'Administratrice Test', role: 'ADMIN', kind: 'TEACHER' },
  { name: 'Enseignant Un', role: 'MEMBER', kind: 'TEACHER' },
  { name: 'Enseignante Deux', role: 'MEMBER', kind: 'TEACHER' },
  { name: 'Étudiante Une', role: 'MEMBER', kind: 'STUDENT', group: 'Master 2 Environnement' },
  { name: 'Étudiant Deux', role: 'MEMBER', kind: 'STUDENT', group: 'Master 2 Environnement' },
  { name: 'Étudiante Trois', role: 'MEMBER', kind: 'STUDENT', group: 'Master 2 Environnement' },
  { name: 'Étudiant Quatre', role: 'MEMBER', kind: 'STUDENT', group: 'Licence 3 Hydrologie' },
  { name: 'Étudiante Cinq', role: 'MEMBER', kind: 'STUDENT', group: 'Licence 3 Hydrologie' },
  { name: 'Enseignant En Attente', role: 'MEMBER', kind: 'TEACHER', pending: true },
  { name: 'Secrétariat SVT', role: 'MEMBER', kind: 'SECRETARY', serves: ['UFR SVT'] },
];
const devOrgPhone = (index) => `+226799800${String(index).padStart(2, '0')}`;

/**
 * Deletes the test organization and what hangs on it (audit entries stay, append-only). Print
 * requests and their journal cannot be deleted: such an organization is emptied and renamed.
 */
async function deleteDevOrg(prisma, organization) {
  const archived = (await prisma.printRequest.count({ where: { organizationId: organization.id } }))
    ? `[dev:org archived ${new Date().toISOString().slice(0, 16)}] Université de test`
    : null;
  await prisma.$transaction(async (tx) => {
    await tx.secretariatScope.deleteMany({
      where: { membership: { organizationId: organization.id } },
    });
    const links = await tx.supervision.findMany({ where: { organizationId: organization.id } });
    const linkIds = links.map((link) => link.id);
    await tx.projectMember.deleteMany({ where: { viaSupervisionId: { in: linkIds } } });
    await tx.supervision.deleteMany({ where: { id: { in: linkIds } } });
    const subscription = await tx.subscription.findUnique({
      where: { organizationId: organization.id },
    });
    if (subscription) {
      await tx.seat.deleteMany({ where: { subscriptionId: subscription.id } });
      await tx.payment.updateMany({
        where: { subscriptionId: subscription.id },
        data: { subscriptionId: null },
      });
      await tx.subscription.delete({ where: { id: subscription.id } });
    }
    await tx.invitation.deleteMany({ where: { organizationId: organization.id } });
    await tx.userImport.deleteMany({ where: { organizationId: organization.id } });
    await tx.membership.deleteMany({ where: { organizationId: organization.id } });
    await tx.project.updateMany({
      where: { template: { organizationId: organization.id } },
      data: { templateId: null },
    });
    await tx.template.deleteMany({ where: { organizationId: organization.id } });
    if (archived) {
      await tx.organization.update({
        where: { id: organization.id },
        data: { name: archived, joinCode: null },
      });
      return;
    }
    await tx.orgGroup.deleteMany({
      where: { organizationId: organization.id, parentId: { not: null } },
    });
    await tx.orgGroup.deleteMany({ where: { organizationId: organization.id } });
    await tx.organization.delete({ where: { id: organization.id } });
  });
}

async function devOrg() {
  const reset = args.includes('--reset');
  const prisma = createPrismaClient(process.env.DATABASE_URL);
  try {
    const existing = await prisma.organization.findFirst({ where: { name: DEV_ORG_NAME } });
    if (existing && !reset) {
      console.error(`"${DEV_ORG_NAME}" already exists: pnpm dev:org --reset recreates it.`);
      process.exitCode = 1;
      return;
    }
    if (existing) await deleteDevOrg(prisma, existing);
    const now = new Date();
    const users = [];
    for (const [index, account] of DEV_ORG_ACCOUNTS.entries()) {
      const phone = devOrgPhone(index);
      users.push(
        await prisma.user.upsert({
          where: { phone },
          create: { phone, phoneVerifiedAt: now, displayName: account.name },
          update: {},
        }),
      );
    }
    const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'BUSINESS' } });
    const seatCount = 11;
    let joinCode = '';
    await prisma.$transaction(async (tx) => {
      const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
      joinCode = Array.from({ length: 10 }, () => alphabet[Math.floor(Math.random() * 32)]).join(
        '',
      );
      const organization = await tx.organization.create({
        data: { type: 'BUSINESS', name: DEV_ORG_NAME, joinCode },
      });
      const subscription = await tx.subscription.create({
        data: {
          planId: plan.id,
          organizationId: organization.id,
          status: 'ACTIVE',
          billingPeriod: 'MONTHLY',
          seatCount,
          currentPeriodStart: now,
          currentPeriodEnd: new Date(now.getTime() + 30 * DAY_MS),
        },
      });
      const ufr = await tx.orgGroup.create({
        data: { organizationId: organization.id, name: 'UFR SVT' },
      });
      const groups = { 'UFR SVT': ufr };
      for (const name of ['Master 2 Environnement', 'Licence 3 Hydrologie']) {
        groups[name] = await tx.orgGroup.create({
          data: { organizationId: organization.id, name, parentId: ufr.id },
        });
      }
      for (const [index, account] of DEV_ORG_ACCOUNTS.entries()) {
        const user = users[index];
        const membership = await tx.membership.create({
          data: {
            organizationId: organization.id,
            userId: user.id,
            role: account.role,
            kind: account.kind,
            status: account.pending ? 'PENDING_APPROVAL' : 'ACTIVE',
            approvedAt: account.pending ? null : now,
            groupId: account.group ? groups[account.group].id : null,
          },
        });
        for (const name of account.serves ?? []) {
          await tx.secretariatScope.create({
            data: { membershipId: membership.id, groupId: groups[name].id },
          });
        }
        if (account.pending) continue;
        const seat = await tx.seat.create({
          data: { subscriptionId: subscription.id, userId: user.id, assignedAt: now },
        });
        // Seats are audited; no actor (a tool), so test accounts stay erasable.
        await tx.auditLog.create({
          data: {
            actorId: null,
            action: 'SEAT_ASSIGNED',
            targetType: 'Seat',
            targetId: seat.id,
            metadata: { subscriptionId: subscription.id, userId: user.id, via: 'dev-tools' },
          },
        });
      }
      const held = DEV_ORG_ACCOUNTS.filter((account) => !account.pending).length;
      await tx.seat.createMany({
        data: Array.from({ length: seatCount - held }, () => ({ subscriptionId: subscription.id })),
      });
      const links = [
        { supervisor: 2, student: 4, status: 'ACTIVE', assigned: true },
        { supervisor: 2, student: 5, status: 'ACTIVE', assigned: true },
        { supervisor: 3, student: 6, status: 'PENDING', assigned: false },
      ];
      for (const link of links) {
        const row = await tx.supervision.create({
          data: {
            organizationId: organization.id,
            supervisorId: users[link.supervisor].id,
            studentId: users[link.student].id,
            status: link.status,
            assignedById: link.assigned ? users[1].id : null,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: null,
            action: link.assigned ? 'SUPERVISION_ASSIGNED' : 'SUPERVISION_REQUESTED',
            targetType: 'Supervision',
            targetId: row.id,
            metadata: { organizationId: organization.id, via: 'dev-tools' },
          },
        });
      }
      await tx.auditLog.create({
        data: {
          actorId: null,
          action: 'DEV_ORG_CREATED',
          targetType: 'Organization',
          targetId: organization.id,
          metadata: { seats: seatCount, via: 'dev-tools' },
        },
      });
    });
    for (const user of users) await applyLimits(user.id);
    const held = DEV_ORG_ACCOUNTS.filter((account) => !account.pending).length;
    console.log(
      `"${DEV_ORG_NAME}": BUSINESS, ${seatCount} seats (${held} held, ${seatCount - held} free), 30 days.`,
    );
    console.log(`Teachers' join code: ${joinCode.slice(0, 5)}-${joinCode.slice(5)}\n`);
    for (const [index, account] of DEV_ORG_ACCOUNTS.entries()) {
      const what = account.pending
        ? 'join request waiting for an admin (no seat)'
        : `${account.role.toLowerCase()}, ${account.kind.toLowerCase()}${account.group ? `, ${account.group}` : ''}${account.serves ? `, serves ${account.serves.join(', ')}` : ''}`;
      console.log(`  ${devOrgPhone(index)}  ${account.name.padEnd(24)} ${what}`);
    }
    console.log(
      '\nSupervision: Enseignant Un follows Étudiante Une and Étudiant Deux; Étudiante Trois asked Enseignante Deux.',
    );
    console.log('Sign in with an SMS code: pnpm dev:otp <phone> prints it.');
  } finally {
    await prisma.$disconnect();
  }
}

if (command === 'share') await share();
else if (command === 'otp') await otp();
else if (command === 'plan') await plan();
else if (command === 'pay') await pay();
else if (command === 'org') await devOrg();
else {
  console.error('Commands: share, otp, plan, pay, org');
  process.exitCode = 1;
}
