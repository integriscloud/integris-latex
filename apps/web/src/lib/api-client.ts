import { API_PREFIX, type ApiErrorCode, apiErrorSchema } from '@integris/shared';

export type ClientErrorCode = ApiErrorCode | 'network' | 'unknown';

export interface ClientError {
  code: ClientErrorCode;
  retryAfter?: number;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ClientError };

async function parseError(response: Response): Promise<ClientError> {
  const parsed = apiErrorSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data : { code: 'unknown' };
}

/**
 * Calls the API from the browser (same origin: `/api` is proxied to the API). The session
 * cookie travels by itself; errors come back as `{ code }` for translation. State-changing calls
 * always carry a JSON body (the API refuses them otherwise).
 */
export async function apiRequest<T = void>(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: object = {},
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(`/${API_PREFIX}/${path}`, {
      method,
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
  return { ok: false, error: await parseError(response) };
}

export const apiPost = <T = void>(path: string, body: object = {}) =>
  apiRequest<T>('POST', path, body);

/** GET with the error code of the API (when the caller explains failures). */
export async function apiRead<T>(
  path: string,
  as: 'json' | 'text' = 'json',
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(`/${API_PREFIX}/${path}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    return { ok: false, error: { code: 'network' } };
  }
  if (!response.ok) {
    return {
      ok: false,
      error: response.status >= 502 ? { code: 'network' } : await parseError(response),
    };
  }
  return { ok: true, data: (as === 'json' ? await response.json() : await response.text()) as T };
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`/${API_PREFIX}/${path}`, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as T;
}

/**
 * Sends a file as a raw body (never multipart), reporting the upload progress (0 to 1): slow
 * mobile connections need to see that a large archive is moving.
 */
export function apiUpload<T>(
  method: 'POST' | 'PUT',
  path: string,
  file: Blob,
  contentType: 'application/octet-stream' | 'application/zip',
  onProgress?: (share: number) => void,
): Promise<ApiResult<T>> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, `/${API_PREFIX}/${path}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('content-type', contentType);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onerror = () => resolve({ ok: false, error: { code: 'network' } });
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ ok: true, data: body as T });
        return;
      }
      const parsed = apiErrorSchema.safeParse(body);
      resolve({ ok: false, error: parsed.success ? parsed.data : { code: 'unknown' } });
    };
    xhr.send(file);
  });
}
