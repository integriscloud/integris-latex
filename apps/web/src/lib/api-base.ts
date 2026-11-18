import { parseEnv, PORTS, webEnvSchema } from '@integris/shared';

/** Where the Next.js server reaches the API (server side only). */
export function apiBaseUrl(): string {
  const { API_INTERNAL_URL } = parseEnv(webEnvSchema, process.env);
  return API_INTERNAL_URL ?? `http://127.0.0.1:${PORTS.api}`;
}
