import type { Space } from '@integris/shared';

type SpaceKey =
  | 'personal'
  | 'personalText'
  | `kinds.${NonNullable<Space['memberKind']> | 'admin'}`
  | `roles.${NonNullable<Space['role']>}`;

type Translate = (key: SpaceKey) => string;

/** Name and subtitle of a space, with a translator of the `Spaces` namespace. */
export function spaceLabels(space: Space, t: Translate): { title: string; subtitle: string } {
  if (space.kind === 'personal') return { title: t('personal'), subtitle: t('personalText') };
  const admin = space.role === 'OWNER' || space.role === 'ADMIN';
  return {
    title: admin ? t('kinds.admin') : t(`kinds.${space.memberKind ?? 'OTHER'}`),
    subtitle: `${space.organizationName ?? ''} · ${t(`roles.${space.role ?? 'MEMBER'}`)}`,
  };
}
