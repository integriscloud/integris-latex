import type { Plan } from '@integris/db';
import { describe, expect, it } from 'vitest';
import { combineQuotas } from './quota.service.js';

// Compilation quotas of the V1 grid (docs/spec.md); the tests read them from here, never the code.
const COMPILE: Record<Plan['code'], Partial<Plan>> = {
  FREE: {
    maxCompileSeconds: 20,
    maxCompilesPerHour: 30,
    autoCompile: false,
    compilePriority: 'LOW',
  },
  STANDARD: {
    maxCompileSeconds: 120,
    maxCompilesPerHour: 120,
    autoCompile: true,
    compilePriority: 'NORMAL',
  },
  TEAM: {
    maxCompileSeconds: 240,
    maxCompilesPerHour: 200,
    autoCompile: true,
    compilePriority: 'HIGH',
  },
  BUSINESS: {
    maxCompileSeconds: 240,
    maxCompilesPerHour: 200,
    autoCompile: true,
    compilePriority: 'HIGH',
  },
};

const plan = (code: Plan['code'], maxProjects: number | null, storageBytes: bigint) =>
  ({ code, nameFr: code, nameEn: code, maxProjects, storageBytes, ...COMPILE[code] }) as Plan;

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
      maxCompileSeconds: 20,
      maxCompilesPerHour: 30,
      autoCompile: false,
      compilePriority: 'LOW',
    });
  });

  it('gives the best compilation quotas and priority of the plans held', () => {
    expect(combineQuotas([plan('FREE', 3, 100n), plan('STANDARD', null, 2000n)])).toMatchObject({
      maxCompileSeconds: 120,
      maxCompilesPerHour: 120,
      autoCompile: true,
      compilePriority: 'NORMAL',
    });
    expect(
      combineQuotas([plan('FREE', 3, 100n), plan('STANDARD', null, 2000n), plan('TEAM', null, 1n)]),
    ).toMatchObject({ maxCompileSeconds: 240, compilePriority: 'HIGH' });
  });
});
