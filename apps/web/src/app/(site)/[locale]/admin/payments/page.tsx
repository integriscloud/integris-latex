import { adminPaymentListSchema } from '@integris/shared';
import { ButtonLink, PageHeader } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { AdminFrame } from '../../../../../components/admin/AdminFrame';
import styles from '../../../../../components/admin/admin.module.css';
import { PaymentsTable } from '../../../../../components/admin/PaymentsTable';
import { nextPageHref, SearchForm } from '../../../../../components/admin/SearchForm';
import { authMetadata } from '../../../../../components/auth/AuthChrome';
import { getPathname } from '../../../../../i18n/navigation';
import { requireSuperAdmin } from '../../../../../lib/admin';
import { serverGet } from '../../../../../lib/server-api';

interface PageProps {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED', 'CREDITED'] as const;
const one = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value) ?? '';

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Admin' });
  return authMetadata(t('payments.title'));
}

/** Back-office: every payment, by payer, transaction, receipt or status (step 14, no mockup). */
export default async function AdminPaymentsPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireSuperAdmin(locale);
  const query = await searchParams;
  const q = one(query.q).slice(0, 120);
  const status = (STATUSES as readonly string[]).includes(one(query.status))
    ? one(query.status)
    : '';
  const search = new URLSearchParams({ q, status, before: one(query.before) });
  for (const [key, value] of [...search]) if (!value) search.delete(key);
  const data = await serverGet(`admin/payments?${search}`, adminPaymentListSchema);
  if (!data) notFound();
  const t = await getTranslations('Admin');
  const path = getPathname({ href: '/admin/payments', locale });
  const users = getPathname({ href: '/admin/users', locale });
  return (
    <AdminFrame me={me} locale={locale} section="payments" path="/admin/payments">
      <PageHeader title={t('payments.title')} subtitle={t('payments.subtitle')} />
      <div className={styles.stack}>
        <SearchForm
          label={t('payments.search')}
          submit={t('searchSubmit')}
          q={q}
          filter={{
            name: 'status',
            label: t('payments.status'),
            value: status,
            options: [
              { value: '', label: t('payments.allStatuses') },
              ...STATUSES.map((value) => ({ value, label: t(`payments.statuses.${value}`) })),
            ],
          }}
        />
        <PaymentsTable payments={data.payments} userHref={(id) => `${users}/${id}`} />
        {data.nextCursor && (
          <div className={styles.pager}>
            <ButtonLink
              href={nextPageHref(path, { q, status }, data.nextCursor)}
              variant="secondary"
            >
              {t('nextPage')}
            </ButtonLink>
          </div>
        )}
      </div>
    </AdminFrame>
  );
}
