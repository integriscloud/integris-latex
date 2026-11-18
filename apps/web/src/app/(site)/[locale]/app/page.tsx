import { projectListSchema } from '@integris/shared';
import { ButtonLink, PageHeader } from '@integris/ui';
import { FileArchive, Plus } from 'lucide-react';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppFrame } from '../../../../components/app/AppFrame';
import { ProjectsView } from '../../../../components/app/ProjectsView';
import { UsageBanner } from '../../../../components/app/UsageBanner';
import { authMetadata } from '../../../../components/auth/AuthChrome';
import { spaceLabels } from '../../../../components/auth/space-labels';
import { getPathname, redirect } from '../../../../i18n/navigation';
import { serverGet } from '../../../../lib/server-api';
import { atProjectLimit } from '../../../../lib/usage';
import { requireMe } from '../../../../lib/session';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Projects' });
  return authMetadata(t('metaTitle'));
}

/** Home of a signed-in user: their projects (mockup etudiant-01, "Mes documents"). */
export default async function ProjectsPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMe(locale);
  const space = me.spaces.find((item) => item.id === me.currentSpaceId);
  if (!space) return redirect({ href: '/spaces', locale });
  const list = await serverGet('projects', projectListSchema);
  if (!list) return redirect({ href: '/login', locale });

  const t = await getTranslations('Projects');
  const ts = await getTranslations('Spaces');
  const blocked = atProjectLimit(list.usage);
  const firstName = me.user.displayName.split(' ')[0] ?? me.user.displayName;

  return (
    <AppFrame me={me} locale={locale} section="projects" path="/app">
      <PageHeader
        title={t('hello', { name: firstName })}
        subtitle={spaceLabels(space, ts).title}
        actions={
          !blocked && (
            <>
              <ButtonLink
                href={`${getPathname({ href: '/app/new', locale })}?tab=zip`}
                variant="secondary"
              >
                <FileArchive size={20} strokeWidth={1.75} aria-hidden="true" />
                {t('import')}
              </ButtonLink>
              <ButtonLink href={getPathname({ href: '/app/new', locale })}>
                <Plus size={20} strokeWidth={1.75} aria-hidden="true" />
                {t('new')}
              </ButtonLink>
            </>
          )
        }
      />
      <UsageBanner usage={list.usage} />
      <ProjectsView list={list} now={new Date().toISOString()} />
    </AppFrame>
  );
}
