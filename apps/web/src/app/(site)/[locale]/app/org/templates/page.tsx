import { orgTemplateListSchema, projectLimitsSchema } from '@integris/shared';
import { PageHeader } from '@integris/ui';
import type { Locale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AppFrame } from '../../../../../../components/app/AppFrame';
import { authMetadata } from '../../../../../../components/auth/AuthChrome';
import { OrgTemplatesView } from '../../../../../../components/exams/OrgPrintView';
import { redirect } from '../../../../../../i18n/navigation';
import { requireOrganizationSpace } from '../../../../../../lib/organization-page';
import { serverGet } from '../../../../../../lib/server-api';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'OrgTemplates' });
  return authMetadata(t('metaTitle'));
}

/** "Modèles officiels" of a BUSINESS, for its owner and admins (step 13, no mockup). */
export default async function OrgTemplatesPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { me, space } = await requireOrganizationSpace(locale, { manager: true, business: true });
  const [templates, limits] = await Promise.all([
    serverGet(`organizations/${space.id}/templates`, orgTemplateListSchema),
    serverGet('projects/limits', projectLimitsSchema),
  ]);
  if (!templates || !limits) return redirect({ href: '/app', locale });
  const t = await getTranslations('OrgTemplates');
  return (
    <AppFrame me={me} locale={locale} section="orgTemplates" path="/app/org/templates">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <OrgTemplatesView
        organizationId={space.id}
        initial={templates}
        maxArchiveBytes={limits.maxArchiveBytes}
      />
    </AppFrame>
  );
}
