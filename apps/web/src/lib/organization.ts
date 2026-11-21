import type { MeResponse, Space } from '@integris/shared';

/** The organization space the user works in, or null in the personal space. */
export function currentOrganization(me: MeResponse): (Space & { kind: 'organization' }) | null {
  const space = me.spaces.find((item) => item.id === me.currentSpaceId);
  return space?.kind === 'organization' ? (space as Space & { kind: 'organization' }) : null;
}

/** Owner, or admin of a BUSINESS: manages the members (the API checks it again). */
export function managesOrganization(space: Space): boolean {
  return (
    space.role === 'OWNER' || (space.role === 'ADMIN' && space.organizationType === 'BUSINESS')
  );
}
