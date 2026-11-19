import {
  type AuthorizeRequest,
  type AuthorizeResponse,
  authorizeResponseSchema,
  COLLAB_SECRET_HEADER,
  INTERNAL_PATHS,
  type LoadResponse,
  loadResponseSchema,
  type StoreRequest,
  type StoreResponse,
  storeResponseSchema,
} from '@integris/shared';
import type { z } from 'zod';

/** The internal API refused or did not answer: the caller refuses or retries, never guesses. */
export class InternalApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Operations of the API used by the collaboration server (see apps/api/src/collab). */
export interface CollabApi {
  authorize(request: AuthorizeRequest): Promise<AuthorizeResponse>;
  load(projectId: string, fileId: string): Promise<LoadResponse>;
  store(request: StoreRequest): Promise<StoreResponse>;
}

/** Client of the internal API (loopback, shared secret). */
export class InternalApi implements CollabApi {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly timeoutMs = 20_000,
  ) {}

  private async post<T extends z.ZodType>(
    path: string,
    body: unknown,
    schema: T,
  ): Promise<z.infer<T>> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', [COLLAB_SECRET_HEADER]: this.secret },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok)
      throw new InternalApiError(response.status, `Internal API ${path}: ${response.status}`);
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new InternalApiError(502, `Internal API ${path}: invalid answer`);
    return parsed.data;
  }

  authorize(request: AuthorizeRequest): Promise<AuthorizeResponse> {
    return this.post(INTERNAL_PATHS.authorize, request, authorizeResponseSchema);
  }

  load(projectId: string, fileId: string): Promise<LoadResponse> {
    return this.post(INTERNAL_PATHS.load, { projectId, fileId }, loadResponseSchema);
  }

  store(request: StoreRequest): Promise<StoreResponse> {
    return this.post(INTERNAL_PATHS.store, request, storeResponseSchema);
  }
}
