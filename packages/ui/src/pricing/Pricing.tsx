'use client';

import { Check } from 'lucide-react';
import { useState } from 'react';
import { ButtonLink } from '../button/Button';
import styles from './pricing.module.css';

export type BillingPeriod = 'monthly' | 'yearly';

export interface PlanPrice {
  /** Formatted amount, e.g. "2 000 F CFA". */
  amount: string;
  /** Unit after the amount, e.g. "/ month". */
  unit: string;
  /** Optional line under the price. */
  note?: string;
}

export interface PlanCardData {
  code: string;
  name: string;
  summary: string;
  badge?: string;
  featured?: boolean;
  prices: Record<BillingPeriod, PlanPrice>;
  features: readonly string[];
  cta: { href: string; label: string };
}

export interface PricingProps {
  /** Accessible name of the period selector. */
  periodLabel: string;
  periodNames: Record<BillingPeriod, string>;
  defaultPeriod?: BillingPeriod;
  plans: readonly PlanCardData[];
}

/** Plan cards with a monthly / yearly selector. All texts and amounts come from the caller. */
export function Pricing({
  periodLabel,
  periodNames,
  defaultPeriod = 'yearly',
  plans,
}: PricingProps) {
  const [period, setPeriod] = useState<BillingPeriod>(defaultPeriod);
  const periods: BillingPeriod[] = ['monthly', 'yearly'];

  return (
    <div className={styles.pricing}>
      <div role="group" aria-label={periodLabel} className={styles.toggle}>
        {periods.map((value) => (
          <button
            key={value}
            type="button"
            className={styles.period}
            aria-pressed={period === value}
            onClick={() => setPeriod(value)}
          >
            {periodNames[value]}
          </button>
        ))}
      </div>
      <ul className={styles.grid}>
        {plans.map((plan) => {
          const price = plan.prices[period];
          return (
            <li
              key={plan.code}
              className={[styles.card, plan.featured && styles.featured].filter(Boolean).join(' ')}
            >
              <div className={styles.head}>
                <h3 className={styles.name}>{plan.name}</h3>
                {plan.badge && <span className={styles.badge}>{plan.badge}</span>}
              </div>
              <p className={styles.summary}>{plan.summary}</p>
              <p className={styles.price}>
                <span className={styles.amount}>{price.amount}</span>{' '}
                <span className={styles.unit}>{price.unit}</span>
              </p>
              {price.note && <p className={styles.note}>{price.note}</p>}
              <ul className={styles.features}>
                {plan.features.map((feature) => (
                  <li key={feature} className={styles.feature}>
                    <Check
                      className={styles.check}
                      size={20}
                      strokeWidth={1.75}
                      aria-hidden="true"
                    />
                    {feature}
                  </li>
                ))}
              </ul>
              <ButtonLink
                className={styles.cta}
                href={plan.cta.href}
                variant={plan.featured ? 'accent' : 'secondary'}
              >
                {plan.cta.label}
              </ButtonLink>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
