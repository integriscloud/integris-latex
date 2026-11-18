'use client';

import type { MeResponse, Space } from '@integris/shared';
import { Alert, SpaceCard } from '@integris/ui';
import { Building2, GraduationCap, Printer, ShieldCheck, User, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useRouter } from '../../i18n/navigation';
import { apiPost, type ClientError } from '../../lib/api-client';
import styles from './auth-forms.module.css';
import { spaceLabels } from './space-labels';
import { useErrorMessage } from './use-auth-request';

const iconOf = (space: Space) => {
  if (space.kind === 'personal') return User;
  if (space.role === 'OWNER' || space.role === 'ADMIN') return ShieldCheck;
  if (space.memberKind === 'TEACHER') return Users;
  if (space.memberKind === 'STUDENT') return GraduationCap;
  if (space.memberKind === 'SECRETARY') return Printer;
  return Building2;
};

/** "Choisir son espace": opens a space without signing in again. */
export function SpaceChooser({ me }: { me: MeResponse }) {
  const t = useTranslations('Spaces');
  const router = useRouter();
  const message = useErrorMessage();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<ClientError | null>(null);

  const choose = async (spaceId: string) => {
    setPending(spaceId);
    setError(null);
    const result = await apiPost<MeResponse>('auth/space', { spaceId });
    if (!result.ok) {
      setPending(null);
      setError(result.error);
      return;
    }
    router.push('/app');
    router.refresh();
  };

  return (
    <>
      {error && <Alert tone="error">{message(error)}</Alert>}
      <ul className={styles.spaces}>
        {me.spaces.map((space) => {
          const { title, subtitle } = spaceLabels(space, t);
          return (
            <li key={space.id}>
              <SpaceCard
                icon={iconOf(space)}
                title={title}
                subtitle={subtitle}
                badge={space.id === me.currentSpaceId ? t('current') : undefined}
                disabled={pending !== null}
                aria-busy={pending === space.id || undefined}
                onClick={() => choose(space.id)}
              />
            </li>
          );
        })}
      </ul>
    </>
  );
}
