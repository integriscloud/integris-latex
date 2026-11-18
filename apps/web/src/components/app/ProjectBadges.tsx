'use client';

import type { ProjectRoleValue } from '@integris/shared';
import { Badge } from '@integris/ui';
import { Eye } from 'lucide-react';
import { useTranslations } from 'next-intl';

/** Role of the user on a project, and the read-only state. */
export function ProjectBadges({ role, readOnly }: { role: ProjectRoleValue; readOnly: boolean }) {
  const t = useTranslations('App');
  return (
    <>
      <Badge tone={role === 'OWNER' ? 'action' : role === 'SUPERVISOR' ? 'accent' : 'neutral'}>
        {t(`roles.${role}`)}
      </Badge>
      {readOnly && (
        <Badge tone="warning" icon={Eye}>
          {t('readOnly')}
        </Badge>
      )}
    </>
  );
}
