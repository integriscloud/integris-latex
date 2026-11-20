import type { Request } from 'express';

/** Address of the client as Express sees it (trust proxy set in configure-app), for audit entries. */
export const ipOf = (request: Request): string | null => request.ip ?? null;
