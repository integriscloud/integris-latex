// Super-administrator role of the back-office (docs/spec.md, "décisions étape 14"): granted or
// revoked only by this command-line script, run on the server by an operator, never through the
// API or the interface. Each change is written in the audit log (no actor, via "cli").
//   pnpm superadmin list
//   pnpm superadmin grant <phone> --reason "<why>"
//   pnpm superadmin revoke <phone> --reason "<why>"
// In production, inside the API container: node apps/api/scripts/superadmin.mjs grant ...
import { createPrismaClient } from '@integris/db';
import { normalizePhone } from '@integris/shared';
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';

/** Grants or revokes the role, with its audit entry; returns false when nothing changed. */
export async function setSuperAdmin(prisma, user, grant, reason, via = 'cli') {
  if (user.isSuperAdmin === grant) return false;
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { isSuperAdmin: grant } });
    await tx.auditLog.create({
      data: {
        actorId: null,
        action: grant ? 'SUPER_ADMIN_GRANTED' : 'SUPER_ADMIN_REVOKED',
        targetType: 'User',
        targetId: user.id,
        metadata: { via, reason, operator: userInfo().username },
      },
    });
  });
  return true;
}

async function main() {
  const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url));
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
  const [command, phoneInput, ...rest] = process.argv.slice(2);
  const reasonAt = rest.indexOf('--reason');
  const reason = reasonAt >= 0 ? (rest[reasonAt + 1] ?? '').trim() : '';
  const prisma = createPrismaClient(process.env.DATABASE_URL);
  try {
    if (command === 'list') {
      const admins = await prisma.user.findMany({ where: { isSuperAdmin: true } });
      for (const admin of admins) console.log(`  ${admin.phone ?? '-'}  ${admin.displayName}`);
      if (!admins.length) console.log('No super-administrator.');
      return;
    }
    if ((command !== 'grant' && command !== 'revoke') || !phoneInput || reason.length < 3) {
      console.error(
        'Usage: superadmin list | grant <phone> --reason "<why>" | revoke <phone> --reason "<why>"',
      );
      process.exitCode = 1;
      return;
    }
    const phone = normalizePhone(phoneInput, '226');
    const user = phone ? await prisma.user.findUnique({ where: { phone } }) : null;
    if (!user) {
      console.error(`No account with the phone ${phoneInput}.`);
      process.exitCode = 1;
      return;
    }
    if (command === 'grant' && user.disabledAt) {
      console.error('This account is disabled.');
      process.exitCode = 1;
      return;
    }
    const grant = command === 'grant';
    const changed = await setSuperAdmin(prisma, user, grant, reason);
    console.log(
      changed
        ? `${user.phone} (${user.displayName}) ${grant ? 'is now' : 'is no longer'} super-administrator.`
        : `Nothing to do: ${user.phone} ${grant ? 'already is' : 'is not'} super-administrator.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
