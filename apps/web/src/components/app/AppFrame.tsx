import type { MeResponse, Space } from '@integris/shared';
import { type AppNavItem, AppShell, AppUser, Logo, type SpaceTone } from '@integris/ui';
import {
  Building2,
  CreditCard,
  FolderOpen,
  Gauge,
  GraduationCap,
  KeyRound,
  LayoutTemplate,
  School,
  Trash2,
  UserCheck,
  UserRound,
  Users,
} from 'lucide-react';
import type { Locale } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { getPathname } from '../../i18n/navigation';
import { managesOrganization } from '../../lib/organization';
import { AuthLanguages } from '../auth/AuthChrome';
import { LogoutButton } from '../auth/LogoutButton';
import { spaceLabels } from '../auth/space-labels';

const ICON = { size: 20, strokeWidth: 1.75, 'aria-hidden': true } as const;

export type AppSection =
  | 'projects'
  | 'templates'
  | 'trash'
  | 'usage'
  | 'billing'
  | 'organization'
  | 'members'
  | 'groups'
  | 'supervision'
  | 'students'
  | 'supervisors'
  | 'join';

const toneOf = (space: Space): SpaceTone => {
  if (space.kind === 'personal') return 'personal';
  if (space.role === 'OWNER' || space.role === 'ADMIN') return 'admin';
  if (space.memberKind === 'TEACHER') return 'teacher';
  if (space.memberKind === 'SECRETARY') return 'secretary';
  return 'student';
};

/** Frame of the signed-in application: side menu of the space, top bar, content. */
export async function AppFrame({
  me,
  locale,
  section,
  path,
  children,
}: {
  me: MeResponse;
  locale: Locale;
  section: AppSection;
  /** Current path, kept by the language switcher. */
  path: string;
  children: ReactNode;
}) {
  const t = await getTranslations('App');
  const tc = await getTranslations('Common');
  const ts = await getTranslations('Spaces');
  const href = (target: string) => getPathname({ href: target, locale });
  const space = me.spaces.find((item) => item.id === me.currentSpaceId) ?? me.spaces[0]!;
  const labels = spaceLabels(space, ts);
  const item = (target: AppSection, path: string, icon: ReactNode): AppNavItem => ({
    href: href(path),
    label: t(`nav.${target}`),
    icon,
    current: section === target,
  });
  // Items of the organization space: management (owner, admins), supervision by kind (BUSINESS).
  const organizationItems: AppNavItem[] = [];
  if (space.kind === 'organization') {
    const business = space.organizationType === 'BUSINESS';
    organizationItems.push(item('organization', '/app/org', <Building2 {...ICON} />));
    if (managesOrganization(space)) {
      organizationItems.push(item('members', '/app/org/members', <Users {...ICON} />));
      if (business) {
        organizationItems.push(item('groups', '/app/org/groups', <School {...ICON} />));
        organizationItems.push(
          item('supervision', '/app/org/supervision', <UserCheck {...ICON} />),
        );
      }
    }
    if (business && space.memberKind === 'TEACHER') {
      organizationItems.push(item('students', '/app/students', <GraduationCap {...ICON} />));
    }
    if (business && space.memberKind === 'STUDENT') {
      organizationItems.push(item('supervisors', '/app/supervisors', <UserCheck {...ICON} />));
    }
  }

  return (
    <AppShell
      brand={<Logo name={tc('productName')} href={href('/app')} inverted />}
      space={{
        title: labels.title,
        subtitle: labels.subtitle,
        tone: toneOf(space),
        href: me.spaces.length > 1 ? href('/spaces') : undefined,
        switchLabel: me.spaces.length > 1 ? t('switchSpace') : undefined,
      }}
      navLabel={t('navLabel')}
      items={[
        {
          href: href('/app'),
          label: t('nav.projects'),
          icon: <FolderOpen {...ICON} />,
          current: section === 'projects',
        },
        {
          href: `${href('/app/new')}?tab=template`,
          label: t('nav.templates'),
          icon: <LayoutTemplate {...ICON} />,
          current: section === 'templates',
        },
        {
          href: href('/app/trash'),
          label: t('nav.trash'),
          icon: <Trash2 {...ICON} />,
          current: section === 'trash',
        },
        {
          href: href('/app/usage'),
          label: t('nav.usage'),
          icon: <Gauge {...ICON} />,
          current: section === 'usage',
        },
        {
          href: href('/app/billing'),
          label: t('nav.billing'),
          icon: <CreditCard {...ICON} />,
          current: section === 'billing',
        },
        ...organizationItems,
        ...(space.kind === 'personal'
          ? [item('join', '/app/join-organization', <KeyRound {...ICON} />)]
          : []),
        { href: href('/account'), label: t('nav.account'), icon: <UserRound {...ICON} /> },
      ]}
      footer={<AppUser name={me.user.displayName} action={<LogoutButton inverse />} />}
      topBar={<AuthLanguages locale={locale} path={path} />}
      openMenuLabel={t('openMenu')}
      closeMenuLabel={t('closeMenu')}
    >
      {children}
    </AppShell>
  );
}
