import { PERSONAL_SPACE_ID, type Space } from '@integris/shared';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Spaces a user can work in: the personal space and each organization where the membership is
 * active. A teacher still PENDING_APPROVAL only gets the personal space.
 */
@Injectable()
export class SpacesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string): Promise<Space[]> {
    const memberships = await this.prisma.client.membership.findMany({
      where: { userId, status: 'ACTIVE' },
      include: { organization: { select: { id: true, name: true, type: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return [
      {
        id: PERSONAL_SPACE_ID,
        kind: 'personal',
        organizationName: null,
        organizationType: null,
        role: null,
        memberKind: null,
      },
      ...memberships.map((membership): Space => ({
        id: membership.organization.id,
        kind: 'organization',
        organizationName: membership.organization.name,
        organizationType: membership.organization.type,
        role: membership.role,
        memberKind: membership.kind,
      })),
    ];
  }

  /** The space opened at login: the only one when there is one, otherwise the user chooses. */
  initialSpace(spaces: Space[]): string | null {
    return spaces.length === 1 ? spaces[0]!.id : null;
  }
}
