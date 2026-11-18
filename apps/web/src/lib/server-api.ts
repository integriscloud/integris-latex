import { API_PREFIX, SESSION_COOKIE } from '@integris/shared';
import { cookies } from 'next/headers';
import { apiBaseUrl } from './api-base';

/**
 * GET from the API during server rendering, with the session cookie of the request (the API
 * checks the session and the rights on every call). Null when the resource is not reachable.
 */
export async function serverGet<T>(
  path: string,
  schema: { parse(value: unknown): T },
): Promise<T | null> {
  const session = (await cookies()).get(SESSION_COOKIE);
  if (!session) return null;
  const response = await fetch(`${apiBaseUrl()}/${API_PREFIX}/${path}`, {
    headers: { cookie: `${SESSION_COOKIE}=${session.value}` },
    cache: 'no-store',
  });
  if (response.status === 401 || response.status === 404) return null;
  if (!response.ok) throw new Error(`API GET ${path}: HTTP ${response.status}`);
  return schema.parse(await response.json());
}
