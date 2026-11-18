import { API_PREFIX, apiErrorSchema, fileSavedSchema } from '@integris/shared';
import type { ClientErrorCode } from '../api-client';
import type { SendResult } from './save-queue';

const contentUrl = (projectId: string, fileId: string) =>
  `/${API_PREFIX}/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/content`;

export type LoadResult =
  | { ok: true; text: string; etag: string; writable: boolean }
  | { ok: false; code: ClientErrorCode };

async function errorCode(response: Response): Promise<ClientErrorCode> {
  const parsed = apiErrorSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data.code : 'unknown';
}

/** Statuses meaning "no answer from the API": the save is retried like a network failure. */
const UNREACHABLE = new Set([0, 502, 503, 504]);

/** Content of a text file and its version (ETag), for the editor. */
export async function loadFile(projectId: string, fileId: string): Promise<LoadResult> {
  let response: Response;
  try {
    response = await fetch(contentUrl(projectId, fileId), {
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    return { ok: false, code: 'network' };
  }
  if (!response.ok) {
    return {
      ok: false,
      code: UNREACHABLE.has(response.status) ? 'network' : await errorCode(response),
    };
  }
  const etag = response.headers.get('etag');
  if (!etag) return { ok: false, code: 'unknown' };
  return {
    ok: true,
    text: await response.text(),
    etag,
    writable: response.headers.get('x-file-writable') === 'true',
  };
}

/**
 * Saves a text file on top of the version `etag`. The text goes as raw UTF-8 bytes
 * (`application/octet-stream`: the API refuses form-like bodies on writes).
 */
export async function saveFile(
  projectId: string,
  fileId: string,
  text: string,
  etag: string,
): Promise<SendResult> {
  let response: Response;
  try {
    response = await fetch(contentUrl(projectId, fileId), {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/octet-stream', 'if-match': etag },
      body: new TextEncoder().encode(text),
    });
  } catch {
    return { ok: false, reason: 'network' };
  }
  if (response.ok) {
    const saved = fileSavedSchema.safeParse(await response.json().catch(() => null));
    return saved.success ? { ok: true, etag: saved.data.etag } : { ok: false, reason: 'network' };
  }
  if (UNREACHABLE.has(response.status)) return { ok: false, reason: 'network' };
  const code = await errorCode(response);
  if (code === 'edit_conflict') return { ok: false, reason: 'conflict' };
  // Several saves of one user at once: wait and retry like a network failure.
  if (code === 'busy') return { ok: false, reason: 'network' };
  return { ok: false, reason: 'error', code };
}
