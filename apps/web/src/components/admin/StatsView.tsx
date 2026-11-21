import type { AdminStats } from '@integris/shared';
import { Panel } from '@integris/ui';
import { getFormatter, getTranslations } from 'next-intl/server';
import styles from './admin.module.css';

/** Statistics of the back-office: totals, then the last 12 months (newest first). */
export async function StatsView({ stats }: { stats: AdminStats }) {
  const t = await getTranslations('Admin.stats');
  const format = await getFormatter();
  const number = (value: number) => format.number(value, { maximumFractionDigits: 0 });
  const money = (value: number) => t('amount', { amount: value });
  const tiles: [string, string][] = [
    [t('users'), number(stats.totals.users)],
    [t('payingUsers'), number(stats.totals.payingUsers)],
    [t('payingOrganizations'), number(stats.totals.payingOrganizations)],
    [t('trials'), number(stats.totals.trials)],
    [t('revenue'), money(stats.totals.revenueXof)],
    [t('compilations'), number(stats.totals.compilations)],
  ];
  return (
    <div className={styles.stack}>
      <dl className={styles.tiles}>
        {tiles.map(([label, value]) => (
          <div key={label} className={styles.tile}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <Panel title={t('monthsTitle')}>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className={styles.muted}>{t('monthsCaption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('month')}</th>
                <th scope="col" className={styles.number}>
                  {t('signups')}
                </th>
                <th scope="col" className={styles.number}>
                  {t('revenue')}
                </th>
                <th scope="col" className={styles.number}>
                  {t('compilations')}
                </th>
                <th scope="col" className={styles.number}>
                  {t('compileMinutes')}
                </th>
              </tr>
            </thead>
            <tbody>
              {[...stats.months].reverse().map((row) => (
                <tr key={row.month}>
                  <th scope="row">
                    {format.dateTime(new Date(`${row.month}-01T12:00:00Z`), {
                      month: 'long',
                      year: 'numeric',
                    })}
                  </th>
                  <td className={styles.number}>{number(row.signups)}</td>
                  <td className={styles.number}>{money(row.revenueXof)}</td>
                  <td className={styles.number}>{number(row.compilations)}</td>
                  <td className={styles.number}>{number(row.compileMinutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
