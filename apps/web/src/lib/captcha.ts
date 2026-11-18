import { type Challenge, solveChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/sha';
import { apiGet } from './api-client';

/**
 * Fetches an ALTCHA challenge from our API and solves it in the browser (proof of work with
 * Web Crypto). Returns the payload expected by the API, or null when it could not be solved.
 */
export async function solveCaptcha(): Promise<string | null> {
  const challenge = await apiGet<Challenge>('auth/captcha');
  const solution = await solveChallenge({ challenge, deriveKey });
  if (!solution) return null;
  return btoa(JSON.stringify({ challenge, solution }));
}
