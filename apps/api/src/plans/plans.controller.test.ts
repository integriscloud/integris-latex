import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { PlansModule } from './plans.module.js';

const row = (code: string, price: number) => ({
  id: `id-${code}`,
  code,
  nameFr: code,
  nameEn: code,
  priceMonthlyXof: price,
  priceYearlyXof: price * 10,
  minSeats: 1,
  maxSeats: 1,
  volumeDiscountFromSeats: null,
  volumeDiscountPercent: null,
  maxProjects: null,
  maxCollaboratorsPerProject: 5,
  maxCompileSeconds: 120,
  maxCompilesPerHour: 120,
  storageBytes: 2n * 1024n ** 3n,
  historyDays: 90,
  autoCompile: true,
  supervisionDashboard: false,
  maxSupervisedStudents: null,
  aiRequestsPerDay: 50,
  compilePriority: 'NORMAL',
  maxAdmins: 0,
  trialDays: null,
  isActive: true,
  updatedAt: new Date(),
});

describe('GET /api/plans', () => {
  let app: INestApplication;
  const findMany = vi.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PlansModule] })
      .useMocker((token) => (token === PrismaService ? { client: { plan: { findMany } } } : {}))
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('lists active plans cheapest first, with public fields only', async () => {
    findMany.mockResolvedValueOnce([row('TEAM', 2500), row('FREE', 0), row('STANDARD', 2000)]);

    const response = await request(app.getHttpServer()).get('/api/plans').expect(200);

    expect(findMany).toHaveBeenCalledWith({ where: { isActive: true } });
    expect(response.headers['cache-control']).toBe('public, max-age=60');
    expect(response.body.map((plan: { code: string }) => plan.code)).toEqual([
      'FREE',
      'STANDARD',
      'TEAM',
    ]);
    expect(response.body[1]).toMatchObject({ priceMonthlyXof: 2000, storageBytes: 2 * 1024 ** 3 });
    for (const field of ['id', 'aiRequestsPerDay', 'volumeDiscountPercent', 'isActive']) {
      expect(response.body[1]).not.toHaveProperty(field);
    }
  });
});
