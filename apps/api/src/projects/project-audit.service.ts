import type { Prisma } from '@integris/db';
import { Injectable } from '@nestjs/common';

/** Who did what: a signed-in user, or nobody (a visitor of a public link). */
export interface Actor {
  userId: string | null;
  ip: string | null;
}

/**
 * Audit entries of a project (append-only table): every share, role change, removed access,
 * invitation and public link (creation, opening, revocation), every move of a file or a folder
 * and every download of the project. Always written with the client of
 * the transaction that makes the change: no change without its entry, no entry without its change.
 */
@Injectable()
export class ProjectAuditService {
  async write(
    tx: Prisma.TransactionClient,
    actor: Actor,
    action: string,
    projectId: string,
    metadata: Prisma.InputJsonObject,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorId: actor.userId,
        action,
        targetType: 'Project',
        targetId: projectId,
        metadata,
        ip: actor.ip,
      },
    });
  }
}
