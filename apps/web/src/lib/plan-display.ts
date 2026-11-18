import type { PublicPlan } from '@integris/shared';
import type { PlanCardData } from '@integris/ui';
import type { useTranslations } from 'next-intl';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

/** A next-intl translator for the "Plans" namespace (server or client). */
export type PlansTranslator = ReturnType<typeof useTranslations<'Plans'>>;

export interface PlanCardOptions {
  locale: string;
  signupHref: string;
}

/** Turn a plan from the API into the texts of a pricing card. Nothing here is hard-coded. */
export function toPlanCard(
  plan: PublicPlan,
  t: PlansTranslator,
  { locale, signupHref }: PlanCardOptions,
): PlanCardData {
  const name = locale === 'fr' ? plan.nameFr : plan.nameEn;
  const free = plan.priceMonthlyXof === 0 && plan.priceYearlyXof === 0;
  const perSeat = plan.minSeats > 1;

  const amount = (value: number) => t('amount', { amount: value });
  const unit = (period: 'monthly' | 'yearly') => {
    if (free) return t('unit.free');
    if (!perSeat) return t(`unit.${period}`);
    return t(period === 'monthly' ? 'unit.seatMonthly' : 'unit.seatYearly');
  };

  const prices: PlanCardData['prices'] = {
    monthly: { amount: amount(plan.priceMonthlyXof), unit: unit('monthly') },
    yearly: { amount: amount(plan.priceYearlyXof), unit: unit('yearly') },
  };
  if (!free) {
    prices.monthly.note = t('alternative.monthly', {
      amount: prices.yearly.amount,
      unit: prices.yearly.unit,
    });
    prices.yearly.note = t('alternative.yearly', {
      amount: prices.monthly.amount,
      unit: prices.monthly.unit,
    });
  }

  return {
    code: plan.code,
    name,
    summary: t(`summary.${plan.code}`),
    badge: plan.trialDays ? t('trial', { days: plan.trialDays }) : undefined,
    featured: plan.trialDays !== null,
    prices,
    features: planFeatures(plan, t),
    cta: { href: signupHref, label: free ? t('cta.free') : t('cta.paid', { name }) },
  };
}

/** Quota lines of a plan, in the order of the grid in docs/spec.md. */
export function planFeatures(plan: PublicPlan, t: PlansTranslator): string[] {
  const features: string[] = [];
  const perSeat = plan.minSeats > 1;

  if (perSeat) {
    features.push(
      plan.maxSeats === null
        ? t('seats.atLeast', { min: plan.minSeats })
        : t('seats.range', { min: plan.minSeats, max: plan.maxSeats }),
    );
  }
  features.push(
    plan.maxProjects === null
      ? t('projects.unlimited')
      : t('projects.limited', { count: plan.maxProjects }),
  );
  features.push(
    plan.maxCollaboratorsPerProject === null
      ? t('collaborators.unlimited')
      : t('collaborators.limited', { count: plan.maxCollaboratorsPerProject }),
  );
  const size =
    plan.storageBytes >= GIB
      ? t('storage.gb', { value: plan.storageBytes / GIB })
      : t('storage.mb', { value: Math.round(plan.storageBytes / MIB) });
  features.push(t(perSeat ? 'storage.perSeat' : 'storage.perAccount', { size }));
  if (plan.historyDays === null) features.push(t('history.unlimited'));
  else if (plan.historyDays === 1) features.push(t('history.hours', { hours: 24 }));
  else features.push(t('history.days', { days: plan.historyDays }));
  features.push(
    plan.maxCompileSeconds % 60 === 0
      ? t('compile.minutes', { minutes: plan.maxCompileSeconds / 60 })
      : t('compile.seconds', { seconds: plan.maxCompileSeconds }),
  );
  features.push(t('compile.perHour', { count: plan.maxCompilesPerHour }));
  if (plan.autoCompile) features.push(t('autoCompile'));
  features.push(t(`priority.${plan.compilePriority}`));
  if (plan.supervisionDashboard && plan.maxSupervisedStudents !== null) {
    features.push(t('supervision', { count: plan.maxSupervisedStudents }));
  }
  return features;
}
