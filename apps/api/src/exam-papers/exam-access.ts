import type { PrintEventType, Prisma } from '@integris/db';

/**
 * Rules shared by the exam papers, the secretariat and the organizations (docs/spec.md, "Devoirs
 * et secrétariat", and the step 13 decisions). Plain functions over a transaction client, so the
 * organizations module can apply them without importing the exam papers module.
 */

export type Tx = Prisma.TransactionClient;

export interface ExamActor {
  userId: string | null;
  ip: string | null;
}

/** BUSINESS organizations where the user is an active member with the teacher profile. */
export async function teacherOrganizationIds(tx: Tx, userId: string): Promise<string[]> {
  const rows = await tx.membership.findMany({
    where: { userId, status: 'ACTIVE', kind: 'TEACHER', organization: { type: 'BUSINESS' } },
    select: { organizationId: true },
  });
  return rows.map((row) => row.organizationId);
}

/**
 * An organization where both users are confirmed teachers, or null: the condition for a
 * co-editor of an exam paper (step 13 decisions).
 */
export async function sharedTeacherOrganization(
  tx: Tx,
  ownerId: string,
  userId: string,
): Promise<string | null> {
  const [owner, other] = await Promise.all([
    teacherOrganizationIds(tx, ownerId),
    teacherOrganizationIds(tx, userId),
  ]);
  return owner.find((id) => other.includes(id)) ?? null;
}

/** Writes one row of the append-only print journal (who, when, IP). */
export async function writePrintEvent(
  tx: Tx,
  actor: ExamActor,
  event: {
    type: PrintEventType;
    projectId: string | null;
    organizationId: string | null;
    printRequestId?: string | null;
    metadata?: Prisma.InputJsonObject;
  },
): Promise<void> {
  await tx.printEvent.create({
    data: {
      type: event.type,
      projectId: event.projectId,
      organizationId: event.organizationId,
      printRequestId: event.printRequestId ?? null,
      actorId: actor.userId,
      ip: actor.ip,
      ...(event.metadata ? { metadata: event.metadata } : {}),
    },
  });
}

/**
 * Takes back the co-editor accesses of exam papers that no longer meet the rule after a
 * membership change of `userId` in `organizationId` (removal, departure, profile no longer
 * teacher): the owner and the co-editor must still be teachers of a same organization. Each
 * removal writes the audit log and the journal of the exam paper. Returns the projects whose
 * open editors must be disconnected.
 */
export async function revokeLostCoeditors(
  tx: Tx,
  actor: ExamActor,
  organizationId: string,
  userId: string,
  reason: string,
): Promise<string[]> {
  const accesses = await tx.projectMember.findMany({
    where: {
      role: 'EDITOR',
      project: { kind: 'ASSIGNMENT' },
      OR: [{ userId }, { project: { ownerId: userId } }],
    },
    include: { project: { select: { id: true, ownerId: true } } },
  });
  const revoked: string[] = [];
  for (const access of accesses) {
    if (await sharedTeacherOrganization(tx, access.project.ownerId, access.userId)) continue;
    await tx.projectMember.delete({ where: { id: access.id } });
    await tx.auditLog.create({
      data: {
        actorId: actor.userId,
        action: 'PROJECT_ACCESS_REMOVED',
        targetType: 'Project',
        targetId: access.projectId,
        metadata: { userId: access.userId, role: 'EDITOR', reason, organizationId },
        ip: actor.ip,
      },
    });
    await writePrintEvent(tx, actor, {
      type: 'COEDITOR_REMOVED',
      projectId: access.projectId,
      organizationId,
      metadata: { userId: access.userId, reason },
    });
    revoked.push(access.projectId);
  }
  return revoked;
}

/** Ids of a group and of all its subgroups (a secretariat serves the whole subtree). */
export function subtreeOf(
  groups: { id: string; parentId: string | null }[],
  roots: Iterable<string>,
): Set<string> {
  const children = new Map<string, string[]>();
  for (const group of groups) {
    if (!group.parentId) continue;
    children.set(group.parentId, [...(children.get(group.parentId) ?? []), group.id]);
  }
  const result = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const id = queue.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    queue.push(...(children.get(id) ?? []));
  }
  return result;
}

/** Ids of a group and of its parents (the secretariats of any of them serve the group). */
export function ancestorsOf(
  groups: { id: string; parentId: string | null }[],
  groupId: string,
): string[] {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const result: string[] = [];
  let current = byId.get(groupId);
  while (current && !result.includes(current.id)) {
    result.push(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return result;
}

/** Full name of a group, parents first. */
export function groupPath(
  groups: { id: string; parentId: string | null; name: string }[],
  groupId: string,
): string {
  const byId = new Map(groups.map((group) => [group.id, group]));
  return ancestorsOf(groups, groupId)
    .reverse()
    .map((id) => byId.get(id)!.name)
    .join(' › ');
}
