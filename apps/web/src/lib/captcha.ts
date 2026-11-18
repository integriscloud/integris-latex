import type { CaptchaChallengeRequest } from '@integris/shared';
import { type Challenge, solveChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/sha';
import { apiPost } from './api-client';

/**
 * Asks our API for an ALTCHA challenge signed for this action and target (phone or e-mail),
 * and solves it in the browser (proof of work with Web Crypto). Returns the payload expected by
 * the API, or null when it could not be obtained or solved.
 */
export async function solveCaptcha(target: CaptchaChallengeRequest): Promise<string | null> {
  const result = await apiPost<Challenge>('auth/captcha', target);
  if (!result.ok) return null;
  const challenge = result.data;
  const solution = await solveChallenge({ challenge, deriveKey });
  if (!solution) return null;
  return btoa(JSON.stringify({ challenge, solution }));
}
