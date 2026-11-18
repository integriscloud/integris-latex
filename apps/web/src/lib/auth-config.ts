import { API_PREFIX, type AuthConfig, authConfigSchema } from '@integris/shared';
import { connection } from 'next/server';
import { apiBaseUrl } from './api-base';

/** Allowed dial codes, code length… from the API, or null when it cannot be reached. */
export async function fetchAuthConfig(): Promise<AuthConfig | null> {
  // Read at request time (limits are server configuration), never at build time.
  await connection();
  try {
    const response = await fetch(`${apiBaseUrl()}/${API_PREFIX}/auth/config`, {
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return authConfigSchema.parse(await response.json());
  } catch (error) {
    console.warn('Auth config unavailable:', error instanceof Error ? error.message : error);
    return null;
  }
}
