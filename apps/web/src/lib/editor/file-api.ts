import { API_PREFIX, apiErrorSchema } from '@integris/shared';
import type { ClientErrorCode } from '../api-client';

const contentUrl = (projectId: string, fileId: string) =>
  `/${API_PREFIX}/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/content`;

export type LoadResult = { ok: true; text: string } | { ok: false; code: ClientErrorCode };

async function errorCode(response: Response): Promise<ClientErrorCode> {
  const parsed = apiErrorSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data.code : 'unknown';
}

/** Statuses meaning "no answer from the API". */
const UNREACHABLE = new Set([0, 502, 503, 504]);

/**
 * Text of a file as last written to storage, for the project index (completion, search). Open
 * files take their live text from the collaboration server instead.
 */
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
  return { ok: true, text: await response.text() };
}
