import {
  API_PREFIX,
  parseEnv,
  PORTS,
  type PublicPlan,
  publicPlansSchema,
  webEnvSchema,
} from '@integris/shared';

/** Seconds between two refreshes of the plans shown on public pages. */
const PLANS_REVALIDATE_SECONDS = 60;

/**
 * Public plans from the API (`Plan` table), or null when the API cannot be reached. Prices are
 * never hard-coded: the caller shows a "temporarily unavailable" message instead.
 */
export async function fetchPublicPlans(): Promise<PublicPlan[] | null> {
  const { API_INTERNAL_URL } = parseEnv(webEnvSchema, process.env);
  const base = API_INTERNAL_URL ?? `http://127.0.0.1:${PORTS.api}`;
  try {
    const response = await fetch(`${base}/${API_PREFIX}/plans`, {
      next: { revalidate: PLANS_REVALIDATE_SECONDS },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return publicPlansSchema.parse(await response.json());
  } catch (error) {
    console.warn('Public plans unavailable:', error instanceof Error ? error.message : error);
    return null;
  }
}
