import { describe, expect, it } from 'vitest';
import { publicPlanSchema } from './plans.js';

const standard = {
  code: 'STANDARD',
  nameFr: 'Standard',
  nameEn: 'Standard',
  priceMonthlyXof: 2000,
  priceYearlyXof: 20000,
  minSeats: 1,
  maxSeats: 1,
  maxProjects: null,
  maxCollaboratorsPerProject: 5,
  maxCompileSeconds: 120,
  maxCompilesPerHour: 120,
  storageBytes: 2 * 1024 ** 3,
  historyDays: 90,
  autoCompile: true,
  supervisionDashboard: false,
  maxSupervisedStudents: null,
  compilePriority: 'NORMAL',
  trialDays: 14,
};

describe('public plan schema', () => {
  it('accepts a plan of the grid', () => {
    expect(publicPlanSchema.parse(standard)).toEqual(standard);
  });

  it('rejects non-integer prices', () => {
    expect(publicPlanSchema.safeParse({ ...standard, priceMonthlyXof: 1999.5 }).success).toBe(
      false,
    );
  });

  it('rejects unknown plan codes', () => {
    expect(publicPlanSchema.safeParse({ ...standard, code: 'PASS' }).success).toBe(false);
  });

  it('strips fields that are not public', () => {
    const parsed = publicPlanSchema.parse({ ...standard, aiRequestsPerDay: 50, id: 'x' });
    expect(parsed).not.toHaveProperty('aiRequestsPerDay');
    expect(parsed).not.toHaveProperty('id');
  });
});
