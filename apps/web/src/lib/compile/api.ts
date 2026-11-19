import {
  API_PREFIX,
  apiErrorSchema,
  type Compilation,
  type CompileState,
  type SynctexIndex,
} from '@integris/shared';
import { apiPost, type ApiResult } from '../api-client';

async function get<T>(
  path: string,
  parse: (response: Response) => Promise<T>,
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(`/${API_PREFIX}/projects/${path}`, { credentials: 'same-origin' });
  } catch {
    return { ok: false, error: { code: 'network' } };
  }
  if (response.ok) return { ok: true, data: await parse(response) };
  const parsed = apiErrorSchema.safeParse(await response.json().catch(() => null));
  return { ok: false, error: parsed.success ? parsed.data : { code: 'unknown' } };
}

const json = <T>(response: Response) => response.json() as Promise<T>;

export const loadCompileState = (projectId: string) =>
  get<CompileState>(`${projectId}/compile`, json);

export const startCompile = (projectId: string, auto: boolean) =>
  apiPost<Compilation>(`projects/${projectId}/compile`, { auto });

export const loadCompilation = (projectId: string, id: string) =>
  get<Compilation>(`${projectId}/compilations/${id}`, json);

export const loadLog = (projectId: string, id: string) =>
  get<string>(`${projectId}/compilations/${id}/log`, (response) => response.text());

export const loadSynctex = (projectId: string, id: string) =>
  get<SynctexIndex>(`${projectId}/compilations/${id}/synctex`, json);
