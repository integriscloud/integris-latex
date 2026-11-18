import { TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import styles from './usage-summary.module.css';

export interface UsageItem {
  label: string;
  /** Readable value, e.g. "2 sur 3" or "12 Mo sur 100 Mo". */
  value: string;
  /** Used share, 0 to 1; omitted when the quota is unlimited. */
  ratio?: number;
}

export interface UsageSummaryProps {
  /** Name of the plan, e.g. a badge. */
  plan: ReactNode;
  items: readonly UsageItem[];
  /** Shown when a quota is reached: clear message. */
  alert?: string;
  /** Upgrade offer shown with the alert. */
  action?: ReactNode;
}

const level = (ratio?: number) =>
  ratio === undefined ? '' : ratio >= 1 ? styles.full : ratio >= 0.8 ? styles.high : '';

/** Quota banner: usage of the plan, and the block message with an upgrade offer. */
export function UsageSummary({ plan, items, alert, action }: UsageSummaryProps) {
  return (
    <section className={[styles.summary, alert && styles.blocked].filter(Boolean).join(' ')}>
      <div className={styles.plan}>{plan}</div>
      <dl className={styles.items}>
        {items.map((item) => (
          <div key={item.label} className={styles.item}>
            <dt className={styles.label}>{item.label}</dt>
            <dd className={styles.value}>
              {item.value}
              {item.ratio !== undefined && (
                <meter
                  className={`${styles.meter} ${level(item.ratio)}`}
                  min={0}
                  max={1}
                  value={Math.min(1, item.ratio)}
                  aria-hidden="true"
                />
              )}
            </dd>
          </div>
        ))}
      </dl>
      {alert && (
        <div className={styles.alert} role="status">
          <TriangleAlert size={20} strokeWidth={1.75} aria-hidden="true" />
          <span>{alert}</span>
          {action}
        </div>
      )}
    </section>
  );
}
