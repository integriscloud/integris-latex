import { billingOverviewSchema, projectListSchema, toReviewListSchema } from '@integris/shared';
import { ButtonLink, PageHeader } from '@integris/ui';
import { FileArchive, Plus } from 'lucide-react';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppFrame } from '../../../../components/app/AppFrame';
import { ProjectsView } from '../../../../components/app/ProjectsView';
import { UsageBanner } from '../../../../components/app/UsageBanner';
import { authMetadata } from '../../../../components/auth/AuthChrome';
import { BillingNotices } from '../../../../components/billing/BillingNotices';
import { ToReviewSection } from '../../../../components/submissions/ToReviewSection';
import { spaceLabels } from '../../../../components/auth/space-labels';
import { getPathname, redirect } from '../../../../i18n/navigation';
import { planNamesOf } from '../../../../lib/billing';
import { fetchPublicPlans } from '../../../../lib/plans';
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

/**
 * Home of a signed-in user: the submissions they have to review, then their projects (mockups
 * professeur-01 "À relire" and etudiant-01 "Mes documents").
 */
export default async function ProjectsPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await requireMe(locale);
  const space = me.spaces.find((item) => item.id === me.currentSpaceId);
  if (!space) return redirect({ href: '/spaces', locale });
  const [list, toReview, billing] = await Promise.all([
    serverGet('projects', projectListSchema),
    serverGet('submissions/to-review', toReviewListSchema),
    // Billing notices (renewal, grace, trial, credit): never blocks the projects page.
    serverGet('billing', billingOverviewSchema).catch(() => null),
  ]);
  const plans = billing?.notices.length ? await fetchPublicPlans() : null;
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
      {billing && (
        <BillingNotices
          notices={billing.notices}
          planNames={planNamesOf(plans, locale)}
          supportEmail={billing.supportEmail}
        />
      )}
      <UsageBanner usage={list.usage} />
      {toReview && <ToReviewSection list={toReview} locale={locale} />}
      <ProjectsView list={list} now={new Date().toISOString()} />
    </AppFrame>
  );
}
