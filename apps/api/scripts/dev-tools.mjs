// Development tools for testing with several accounts on latex-dev (never in production).
//   pnpm dev:share <project id or name> <phone> [EDITOR|SUPERVISOR|REVIEWER|VIEWER|remove]
//   pnpm dev:otp <phone>
// Sharing arrives in the app at step 8; until then, this adds an account to a project with a
// role. The account is created when the phone number has none (sign-in by SMS code, the code
// being read with dev:otp since SMS are only written to the logs on latex-dev).
import { createPrismaClient } from '@integris/db';
import { COLLAB_EVENTS_CHANNEL, normalizePhone } from '@integris/shared';
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

if (command === 'share') await share();
else if (command === 'otp') await otp();
else {
  console.error('Commands: share, otp');
  process.exitCode = 1;
}
