import { z } from 'zod';
import { AUTH_ERROR_CODES } from './auth.js';
import { BILLING_ERROR_CODES } from './billing.js';
import { ORG_ERROR_CODES } from './organizations.js';
import { PROJECT_ERROR_CODES } from './projects.js';
import { SHARING_ERROR_CODES } from './sharing.js';
import { SUBMISSION_ERROR_CODES } from './submissions.js';

/** Every `{ code }` the API can answer with. The web app translates each one. */
export const API_ERROR_CODES = [
  ...AUTH_ERROR_CODES,
  ...PROJECT_ERROR_CODES,
  ...SHARING_ERROR_CODES,
  ...SUBMISSION_ERROR_CODES,
  ...BILLING_ERROR_CODES,
  ...ORG_ERROR_CODES,
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const apiErrorSchema = z.object({
  code: z.enum(API_ERROR_CODES),
  // Seconds before the action can be retried (rate_limited, locked).
  retryAfter: z.number().int().nonnegative().optional(),
});
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;
