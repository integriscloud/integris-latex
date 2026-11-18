import { projectLimitsSchema, projectListSchema, templateListSchema } from '@integris/shared';
import { PageHeader } from '@integris/ui';
import { ArrowLeft } from 'lucide-react';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppFrame } from '../../../../../components/app/AppFrame';
import styles from '../../../../../components/app/app.module.css';
import { NewProject, type NewProjectTab } from '../../../../../components/app/NewProject';
import { UsageBanner } from '../../../../../components/app/UsageBanner';
import { authMetadata } from '../../../../../components/auth/AuthChrome';
import { getPathname, redirect } from '../../../../../i18n/navigation';
import { serverGet } from '../../../../../lib/server-api';
import { atProjectLimit } from '../../../../../lib/usage';
import { requireMe } from '../../../../../lib/session';

interface PageProps {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ tab?: string }>;
}

const TABS: readonly NewProjectTab[] = ['blank', 'template', 'zip'];

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'NewProject' });
  return authMetadata(t('metaTitle'));
}

/** New project: empty, from a template or from a ZIP archive (screen without mockup). */
export default async function NewProjectPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMe(locale);
  if (!me.currentSpaceId) return redirect({ href: '/spaces', locale });
  const [list, templates, limits] = await Promise.all([
    serverGet('projects', projectListSchema),
    serverGet('templates', templateListSchema),
    serverGet('projects/limits', projectLimitsSchema),
  ]);
  if (!list || !templates || !limits) return redirect({ href: '/login', locale });

  const t = await getTranslations('NewProject');
  const requested = (await searchParams).tab;
  const tab = TABS.find((item) => item === requested) ?? 'blank';

  return (
    <AppFrame
      me={me}
      locale={locale}
      section={tab === 'template' ? 'templates' : 'projects'}
      path="/app/new"
    >
      <PageHeader
        back={
          <a className={styles.back} href={getPathname({ href: '/app', locale })}>
            <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
            {t('back')}
          </a>
        }
        title={t('title')}
      />
      {atProjectLimit(list.usage) ? (
        <UsageBanner usage={list.usage} />
      ) : (
        <NewProject tab={tab} templates={templates} limits={limits} />
      )}
    </AppFrame>
  );
}
