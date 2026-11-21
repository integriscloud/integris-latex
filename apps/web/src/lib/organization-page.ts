import type { MeResponse, Space } from '@integris/shared';
import type { Locale } from 'next-intl';
import { redirect } from '../i18n/navigation';
import { currentOrganization, managesOrganization } from './organization';
import { requireMe } from './session';

/**
 * The signed-in user and the organization space they work in, for an organization page. Elsewhere
 * (personal space, a role or plan the page is not for), back to the projects; the API checks the
 * rights again on every call.
 */
export async function requireOrganizationSpace(
  locale: Locale,
  need: {
    manager?: boolean;
    business?: boolean;
    kind?: 'TEACHER' | 'STUDENT' | 'SECRETARY';
  } = {},
): Promise<{ me: MeResponse; space: Space }> {
  const me = await requireMe(locale);
  if (!me.currentSpaceId) return redirect({ href: '/spaces', locale });
  const space = currentOrganization(me);
  if (
    !space ||
    (need.manager && !managesOrganization(space)) ||
    (need.business && space.organizationType !== 'BUSINESS') ||
    (need.kind && space.memberKind !== need.kind)
  ) {
    return redirect({ href: '/app', locale });
  }
  return { me, space };
}
