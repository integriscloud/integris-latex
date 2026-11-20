import type { ToReviewList } from '@integris/shared';
import { ButtonLink, Panel, SubmissionStatusBadge } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getPathname } from '../../i18n/navigation';
import styles from './submissions.module.css';

/**
 * Submissions waiting for the user's review, nearest deadline first (mockup professeur-01,
 * "À relire en priorité"). Shown only when there is one.
 */
export async function ToReviewSection({ list, locale }: { list: ToReviewList; locale: Locale }) {
  if (!list.submissions.length) return null;
  const t = await getTranslations('Submissions');
  const format = await getFormatter();
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });

  return (
    <Panel title={t('toReview.title')}>
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('toReview.student')}</th>
              <th scope="col">{t('toReview.document')}</th>
              <th scope="col">{t('toReview.part')}</th>
              <th scope="col">{t('toReview.received')}</th>
              <th scope="col">{t('toReview.due')}</th>
              <th scope="col">{t('toReview.status')}</th>
              <th scope="col">
                <span className={styles.meta}>{t('toReview.review')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.submissions.map((item) => {
              const title = item.title ?? t('untitled');
              return (
                <tr key={item.id}>
                  <td>{item.author.name}</td>
                  <td>{item.projectName}</td>
                  <td>
                    {title}
                    {item.lastNumber && ` · ${t('version', { number: item.lastNumber })}`}
                  </td>
                  <td>{item.receivedAt ? date(item.receivedAt) : ''}</td>
                  <td>{item.dueAt ? date(item.dueAt) : t('noDue')}</td>
                  <td>
                    <SubmissionStatusBadge
                      status={item.status}
                      label={t(`status.${item.status}`)}
                    />
                  </td>
                  <td>
                    <ButtonLink
                      href={getPathname({
                        href: `/app/projects/${item.projectId}/submissions/${item.id}`,
                        locale,
                      })}
                      variant="secondary"
                      aria-label={t('toReview.reviewOf', { title })}
                    >
                      {t('toReview.review')}
                    </ButtonLink>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
