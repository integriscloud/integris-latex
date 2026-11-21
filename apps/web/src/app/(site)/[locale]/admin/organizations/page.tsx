import { adminOrgListSchema } from '@integris/shared';
import { Badge, ButtonLink, PageHeader } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { AdminFrame } from '../../../../../components/admin/AdminFrame';
import styles from '../../../../../components/admin/admin.module.css';
import { nextPageHref, SearchForm } from '../../../../../components/admin/SearchForm';
import { authMetadata } from '../../../../../components/auth/AuthChrome';
import { getPathname } from '../../../../../i18n/navigation';
import { requireSuperAdmin } from '../../../../../lib/admin';
import { serverGet } from '../../../../../lib/server-api';

interface PageProps {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const one = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value) ?? '';

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Admin' });
  return authMetadata(t('organizations.title'));
}

/** Back-office: Team and Business organizations (step 14, screen without mockup). */
export default async function AdminOrganizationsPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireSuperAdmin(locale);
  const query = await searchParams;
  const q = one(query.q).slice(0, 120);
  const search = new URLSearchParams({ q, before: one(query.before) });
  const data = await serverGet(`admin/organizations?${search}`, adminOrgListSchema);
  if (!data) notFound();
  const t = await getTranslations('Admin');
  const format = await getFormatter();
  const path = getPathname({ href: '/admin/organizations', locale });
  return (
    <AdminFrame me={me} locale={locale} section="organizations" path="/admin/organizations">
      <PageHeader title={t('organizations.title')} subtitle={t('organizations.subtitle')} />
      <div className={styles.stack}>
        <SearchForm label={t('organizations.search')} submit={t('searchSubmit')} q={q} />
        {data.organizations.length ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{t('organizations.name')}</th>
                  <th scope="col">{t('organizations.owner')}</th>
                  <th scope="col">{t('organizations.plan')}</th>
                  <th scope="col" className={styles.number}>
                    {t('organizations.members')}
                  </th>
                  <th scope="col">{t('organizations.periodEnd')}</th>
                </tr>
              </thead>
              <tbody>
                {data.organizations.map((organization) => (
                  <tr key={organization.id}>
                    <th scope="row">
                      <a className={styles.link} href={`${path}/${organization.id}`}>
                        {organization.name}
                      </a>{' '}
                      {organization.pilotTrial && (
                        <Badge tone="accent">{t('organizations.pilot')}</Badge>
                      )}
                    </th>
                    <td>{organization.ownerName ?? '—'}</td>
                    <td>
                      {organization.subscription
                        ? t('organizations.planStatus', {
                            plan: organization.subscription.planCode,
                            status: organization.subscription.status,
                          })
                        : organization.type}
                    </td>
                    <td className={styles.number}>{organization.members}</td>
                    <td>
                      {organization.subscription
                        ? format.dateTime(new Date(organization.subscription.currentPeriodEnd), {
                            dateStyle: 'medium',
                          })
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={styles.muted}>{t('noResult')}</p>
        )}
        {data.nextCursor && (
          <div className={styles.pager}>
            <ButtonLink href={nextPageHref(path, { q }, data.nextCursor)} variant="secondary">
              {t('nextPage')}
            </ButtonLink>
          </div>
        )}
      </div>
    </AdminFrame>
  );
}
