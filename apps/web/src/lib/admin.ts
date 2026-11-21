import type { MeResponse } from '@integris/shared';
import type { Locale } from 'next-intl';
import { notFound } from 'next/navigation';
import { requireMe } from './session';

/**
 * A page of the back-office: signed in, and super-administrator (the API checks the role again
 * on every request); anyone else sees "not found".
 */
export async function requireSuperAdmin(locale: Locale): Promise<MeResponse> {
  const me = await requireMe(locale);
  if (!me.user.superAdmin) notFound();
  return me;
}
