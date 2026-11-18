import { describe, expect, it } from 'vitest';
import { GIB, MIB, PLANS } from './plans.js';

const byCode = Object.fromEntries(PLANS.map((plan) => [plan.code, plan]));

describe('seeded plans match the grid of docs/spec.md', () => {
  it('defines exactly the four V1 plans', () => {
    expect(PLANS.map((plan) => plan.code)).toEqual(['FREE', 'STANDARD', 'TEAM', 'BUSINESS']);
  });

  it('uses integer XOF prices (per seat for TEAM and BUSINESS)', () => {
    expect(PLANS.map((plan) => [plan.code, plan.priceMonthlyXof, plan.priceYearlyXof])).toEqual([
      ['FREE', 0, 0],
      ['STANDARD', 2000, 20000],
      ['TEAM', 2500, 25000],
      ['BUSINESS', 2000, 20000],
    ]);
    for (const plan of PLANS) {
      expect(Number.isInteger(plan.priceMonthlyXof)).toBe(true);
      expect(Number.isInteger(plan.priceYearlyXof)).toBe(true);
    }
  });

  it('sets seats, owner included', () => {
    expect(PLANS.map((plan) => [plan.code, plan.minSeats, plan.maxSeats])).toEqual([
      ['FREE', 1, 1],
      ['STANDARD', 1, 1],
      ['TEAM', 2, 10],
      ['BUSINESS', 10, null],
    ]);
  });

  it('keeps the Business volume discount threshold without an undecided rate', () => {
    expect(byCode.BUSINESS).toMatchObject({
      volumeDiscountFromSeats: 100,
      volumeDiscountPercent: null,
    });
    for (const code of ['FREE', 'STANDARD', 'TEAM'] as const) {
      expect(byCode[code]).not.toHaveProperty('volumeDiscountFromSeats');
    }
  });

  it('sets projects, collaborators, compilation and history quotas', () => {
    expect(
      PLANS.map((plan) => [
        plan.code,
        plan.maxProjects,
        plan.maxCollaboratorsPerProject,
        plan.maxCompileSeconds,
        plan.maxCompilesPerHour,
        plan.historyDays,
        plan.autoCompile,
        plan.compilePriority,
      ]),
    ).toEqual([
      ['FREE', 3, 1, 20, 30, 1, false, 'LOW'],
      ['STANDARD', null, 5, 120, 120, 90, true, 'NORMAL'],
      ['TEAM', null, null, 240, 200, null, true, 'HIGH'],
      ['BUSINESS', null, null, 240, 200, null, true, 'HIGH'],
    ]);
  });

  it('sets storage per seat in binary units', () => {
    expect(MIB).toBe(1_048_576n);
    expect(GIB).toBe(1_073_741_824n);
    expect(PLANS.map((plan) => [plan.code, plan.storageBytes])).toEqual([
      ['FREE', 104_857_600n],
      ['STANDARD', 2_147_483_648n],
      ['TEAM', 5_368_709_120n],
      ['BUSINESS', 5_368_709_120n],
    ]);
  });

  it('reserves the supervision dashboard (30 students) and 5 admins to BUSINESS', () => {
    expect(PLANS.filter((plan) => plan.supervisionDashboard).map((plan) => plan.code)).toEqual([
      'BUSINESS',
    ]);
    expect(byCode.BUSINESS).toMatchObject({ maxSupervisedStudents: 30, maxAdmins: 5 });
    for (const code of ['FREE', 'STANDARD', 'TEAM'] as const) {
      expect(byCode[code]).not.toHaveProperty('maxAdmins');
    }
  });

  it('sets AI requests per day (V2) and the 14-day Standard trial', () => {
    expect(PLANS.map((plan) => [plan.code, plan.aiRequestsPerDay])).toEqual([
      ['FREE', 5],
      ['STANDARD', 50],
      ['TEAM', 100],
      ['BUSINESS', 100],
    ]);
    expect(PLANS.filter((plan) => 'trialDays' in plan).map((plan) => plan.code)).toEqual([
      'STANDARD',
    ]);
    expect(byCode.STANDARD).toMatchObject({ trialDays: 14 });
  });
});
