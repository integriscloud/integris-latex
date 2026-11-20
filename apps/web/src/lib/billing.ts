import type { PublicPlan } from '@integris/shared';

/** Plan code → name in the language of the page (names of the `Plan` table). */
export function planNamesOf(plans: PublicPlan[] | null, locale: string): Record<string, string> {
  return Object.fromEntries(
    (plans ?? []).map((plan) => [plan.code, locale === 'fr' ? plan.nameFr : plan.nameEn]),
  );
}
