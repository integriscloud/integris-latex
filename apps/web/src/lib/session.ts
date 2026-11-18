import { API_PREFIX, type MeResponse, meResponseSchema, SESSION_COOKIE } from '@integris/shared';
import type { Locale } from 'next-intl';
import { cookies } from 'next/headers';
import { redirect } from '../i18n/navigation';
import { apiBaseUrl } from './api-base';

/**
 * The signed-in user, read from the API with the session cookie of the request (the API checks
 * the session on every call). Null when signed out or when the session is no longer valid.
 */
export async function getMe(): Promise<MeResponse | null> {
  const session = (await cookies()).get(SESSION_COOKIE);
  if (!session) return null;
  const response = await fetch(`${apiBaseUrl()}/${API_PREFIX}/auth/me`, {
    headers: { cookie: `${SESSION_COOKIE}=${session.value}` },
    cache: 'no-store',
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`Session check failed: HTTP ${response.status}`);
  return meResponseSchema.parse(await response.json());
}

/** The signed-in user, or a redirect to the sign-in page. */
export async function requireMe(locale: Locale): Promise<MeResponse> {
  const me = await getMe();
  if (!me) return redirect({ href: '/login', locale });
  return me;
}

/** Where a signed-in user lands: their space, or the space chooser when none is open. */
export const homePath = (me: MeResponse) => (me.currentSpaceId ? '/app' : '/spaces');
