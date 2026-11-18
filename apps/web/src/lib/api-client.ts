import { API_PREFIX, type AuthErrorCode, authErrorSchema } from '@integris/shared';

export type ClientErrorCode = AuthErrorCode | 'network' | 'unknown';

export interface ClientError {
  code: ClientErrorCode;
  retryAfter?: number;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ClientError };

/**
 * POST to the API from the browser (same origin: `/api` is proxied to the API). The session
 * cookie travels by itself; errors come back as `{ code }` for translation.
 */
export async function apiPost<T = void>(path: string, body: object = {}): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(`/${API_PREFIX}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: { code: 'network' } };
  }
  if (response.ok) {
    const data = response.status === 204 ? undefined : await response.json();
    return { ok: true, data: data as T };
  }
  const parsed = authErrorSchema.safeParse(await response.json().catch(() => null));
  return { ok: false, error: parsed.success ? parsed.data : { code: 'unknown' } };
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`/${API_PREFIX}/${path}`, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as T;
}
