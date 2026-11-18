import type { Plan } from '@integris/db';
import { describe, expect, it } from 'vitest';
import { combineQuotas } from './quota.service.js';

const plan = (code: Plan['code'], maxProjects: number | null, storageBytes: bigint) =>
  ({ code, nameFr: code, nameEn: code, maxProjects, storageBytes }) as Plan;

describe('combineQuotas', () => {
  it('keeps the best value of each quota, unlimited winning', () => {
    expect(
      combineQuotas([
        plan('FREE', 3, 100n),
        plan('TEAM', null, 5000n),
        plan('STANDARD', null, 2000n),
      ]),
    ).toMatchObject({ planCode: 'TEAM', maxProjects: null, storageBytes: 5000n });
  });

  it('never pools quotas of several seats', () => {
    expect(
      combineQuotas([
        plan('FREE', 3, 100n),
        plan('BUSINESS', null, 5000n),
        plan('TEAM', null, 5000n),
      ]),
    ).toMatchObject({ planCode: 'BUSINESS', storageBytes: 5000n });
  });

  it('falls back to the FREE plan alone', () => {
    expect(combineQuotas([plan('FREE', 3, 100n)])).toEqual({
      planCode: 'FREE',
      planName: { fr: 'FREE', en: 'FREE' },
      maxProjects: 3,
      storageBytes: 100n,
    });
  });
});
