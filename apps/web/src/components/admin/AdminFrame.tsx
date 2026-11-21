import type { MeResponse } from '@integris/shared';
import { type AppNavItem, AppShell, AppUser, Logo } from '@integris/ui';
import {
  ArrowLeft,
  Building2,
  CreditCard,
  LayoutDashboard,
  LayoutTemplate,
  ReceiptText,
  TicketPercent,
  Users,
} from 'lucide-react';
import type { Locale } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { getPathname } from '../../i18n/navigation';
import { fetchAuthConfig } from '../../lib/auth-config';
import { AuthLanguages } from '../auth/AuthChrome';
import { LogoutButton } from '../auth/LogoutButton';
import { AdminActionsProvider } from './admin-actions';

const ICON = { size: 20, strokeWidth: 1.75, 'aria-hidden': true } as const;

export type AdminSection =
  'dashboard' | 'plans' | 'users' | 'organizations' | 'payments' | 'promoCodes' | 'templates';

/** Frame of the back-office: its own side menu, the way back to the application. */
export async function AdminFrame({
  me,
  locale,
  section,
  path,
  children,
}: {
  me: MeResponse;
  locale: Locale;
  section: AdminSection;
  path: string;
  children: ReactNode;
}) {
  const t = await getTranslations('Admin');
  const tc = await getTranslations('Common');
  const config = await fetchAuthConfig();
  const href = (target: string) => getPathname({ href: target, locale });
  const item = (target: AdminSection, to: string, icon: ReactNode): AppNavItem => ({
    href: href(to),
    label: t(`nav.${target}`),
    icon,
    current: section === target,
  });
  return (
    <AppShell
      brand={<Logo name={tc('productName')} href={href('/admin')} inverted />}
      space={{ title: t('spaceTitle'), subtitle: t('spaceSubtitle'), tone: 'admin' }}
      navLabel={t('navLabel')}
      items={[
        item('dashboard', '/admin', <LayoutDashboard {...ICON} />),
        item('plans', '/admin/plans', <CreditCard {...ICON} />),
        item('users', '/admin/users', <Users {...ICON} />),
        item('organizations', '/admin/organizations', <Building2 {...ICON} />),
        item('payments', '/admin/payments', <ReceiptText {...ICON} />),
        item('promoCodes', '/admin/promo-codes', <TicketPercent {...ICON} />),
        item('templates', '/admin/templates', <LayoutTemplate {...ICON} />),
        { href: href('/app'), label: t('nav.back'), icon: <ArrowLeft {...ICON} /> },
      ]}
      footer={<AppUser name={me.user.displayName} action={<LogoutButton inverse />} />}
      topBar={<AuthLanguages locale={locale} path={path} />}
      openMenuLabel={t('openMenu')}
      closeMenuLabel={t('closeMenu')}
    >
      <AdminActionsProvider
        phone={me.user.phone}
        otpLength={config?.otpLength ?? 6}
        locale={locale}
      >
        {children}
      </AdminActionsProvider>
    </AppShell>
  );
}
