'use client';

import { type ProjectUsage, usageLevel } from '@integris/shared';
import { Badge, ButtonLink, UsageSummary } from '@integris/ui';
import { useLocale, useTranslations } from 'next-intl';
import { getPathname } from '../../i18n/navigation';
import { formatBytes } from '../../lib/format';

/**
 * Quota banner of the projects pages: projects and storage of the plan (values from the `Plan`
 * table), with a warning from 80 %, a clear block message at 100 % and the upgrade offer.
 */
export function UsageBanner({ usage }: { usage: ProjectUsage }) {
  const t = useTranslations('App.usage');
  const locale = useLocale();
  const plan = locale === 'fr' ? usage.planName.fr : usage.planName.en;
  const projects = usageLevel(usage.projects, usage.maxProjects);
  const storage = usageLevel(usage.storageBytes, usage.maxStorageBytes);
  // The block message first, then the 80 % warnings (docs/spec.md, "Alertes de consommation").
  const alert =
    projects === 'full'
      ? t('projectLimit', { max: usage.maxProjects ?? 0, plan })
      : storage === 'full'
        ? t('storageLimit', { plan })
        : projects === 'warn'
          ? t('projectWarn', { count: usage.projects, max: usage.maxProjects ?? 0, plan })
          : storage === 'warn'
            ? t('storageWarn', { plan })
            : undefined;

  return (
    <UsageSummary
      plan={
        <Badge tone={usage.planCode === 'FREE' ? 'neutral' : 'accent'}>{t('plan', { plan })}</Badge>
      }
      items={[
        {
          label: t('projects'),
          value:
            usage.maxProjects === null
              ? t('projectsUnlimited', { count: usage.projects })
              : t('projectsOf', { count: usage.projects, max: usage.maxProjects }),
          ratio: usage.maxProjects === null ? undefined : usage.projects / usage.maxProjects,
        },
        {
          label: t('storage'),
          value: t('storageOf', {
            used: formatBytes(usage.storageBytes, locale),
            max: formatBytes(usage.maxStorageBytes, locale),
          }),
          ratio: usage.storageBytes / usage.maxStorageBytes,
        },
      ]}
      alert={alert}
      action={
        alert && (
          <ButtonLink
            href={getPathname({ href: '/app/billing/checkout', locale })}
            variant="accent"
          >
            {t('upgrade')}
          </ButtonLink>
        )
      }
    />
  );
}
