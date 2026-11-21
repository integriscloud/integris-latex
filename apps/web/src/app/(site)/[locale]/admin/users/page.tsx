import { adminUserListSchema, formatPhone } from '@integris/shared';
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
  return authMetadata(t('users.title'));
}

/** Back-office: accounts, searched by name, phone or e-mail (step 14, screen without mockup). */
export default async function AdminUsersPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireSuperAdmin(locale);
  const query = await searchParams;
  const q = one(query.q).slice(0, 120);
  const before = one(query.before);
  const search = new URLSearchParams({ q, before });
  const data = await serverGet(`admin/users?${search}`, adminUserListSchema);
  if (!data) notFound();
  const t = await getTranslations('Admin');
  const format = await getFormatter();
  const path = getPathname({ href: '/admin/users', locale });
  return (
    <AdminFrame me={me} locale={locale} section="users" path="/admin/users">
      <PageHeader title={t('users.title')} subtitle={t('users.subtitle')} />
      <div className={styles.stack}>
        <SearchForm label={t('users.search')} submit={t('searchSubmit')} q={q} />
        {data.users.length ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{t('users.name')}</th>
                  <th scope="col">{t('users.phone')}</th>
                  <th scope="col">{t('users.email')}</th>
                  <th scope="col">{t('users.created')}</th>
                </tr>
              </thead>
              <tbody>
                {data.users.map((user) => (
                  <tr key={user.id}>
                    <th scope="row">
                      <a className={styles.link} href={`${path}/${user.id}`}>
                        {user.displayName}
                      </a>{' '}
                      {user.superAdmin && <Badge tone="info">{t('users.superAdmin')}</Badge>}{' '}
                      {user.disabled && <Badge tone="danger">{t('users.disabled')}</Badge>}
                    </th>
                    <td>{user.phone ? formatPhone(user.phone) : '—'}</td>
                    <td>{user.email ?? '—'}</td>
                    <td>{format.dateTime(new Date(user.createdAt), { dateStyle: 'medium' })}</td>
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
