import type { PublicPlan } from '@integris/shared';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import fr from '../../messages/fr.json';
import { planFeatures, toPlanCard } from './plan-display';

const base: PublicPlan = {
  code: 'FREE',
  nameFr: 'Gratuit',
  nameEn: 'Free',
  priceMonthlyXof: 0,
  priceYearlyXof: 0,
  minSeats: 1,
  maxSeats: 1,
  maxProjects: 3,
  maxCollaboratorsPerProject: 1,
  maxCompileSeconds: 20,
  maxCompilesPerHour: 30,
  storageBytes: 100 * 1024 ** 2,
  historyDays: 1,
  autoCompile: false,
  supervisionDashboard: false,
  maxSupervisedStudents: null,
  compilePriority: 'LOW',
  trialDays: null,
};

const team: PublicPlan = {
  ...base,
  code: 'TEAM',
  nameFr: 'Équipe',
  nameEn: 'Team',
  priceMonthlyXof: 2500,
  priceYearlyXof: 25000,
  minSeats: 2,
  maxSeats: 10,
  maxProjects: null,
  maxCollaboratorsPerProject: null,
  maxCompileSeconds: 240,
  storageBytes: 5 * 1024 ** 3,
  historyDays: null,
  autoCompile: true,
  compilePriority: 'HIGH',
};

const tFr = createTranslator({ locale: 'fr', messages: fr, namespace: 'Plans' });
const tEn = createTranslator({ locale: 'en', messages: en, namespace: 'Plans' });
const options = { locale: 'fr', signupHref: '/fr/signup' };
const nbsp = (text: string) => text.replace(/[\u202f\u00a0]/g, ' ');

describe('plan cards', () => {
  it('show the prices read from the plan, per seat for team plans', () => {
    const card = toPlanCard(team, tFr, options);
    expect(card.name).toBe('Équipe');
    expect(nbsp(card.prices.monthly.amount)).toBe('2 500 FCFA');
    expect(card.prices.monthly.unit).toBe('/ siège / mois');
    expect(nbsp(card.prices.yearly.amount)).toBe('25 000 FCFA');
    expect(nbsp(card.prices.monthly.note ?? '')).toBe(
      'ou 25 000 FCFA / siège / an en paiement annuel',
    );
    expect(card.cta).toEqual({ href: '/fr/signup', label: 'Choisir Équipe' });
  });

  it('follow price changes in the database', () => {
    const card = toPlanCard({ ...team, priceMonthlyXof: 3000 }, tEn, { ...options, locale: 'en' });
    expect(card.name).toBe('Team');
    expect(card.prices.monthly.amount).toBe('3,000 FCFA');
  });

  it('present the free plan without an alternative price', () => {
    const card = toPlanCard(base, tFr, options);
    expect(card.prices.yearly.note).toBeUndefined();
    expect(card.cta.label).toBe('Commencer gratuitement');
    expect(card.featured).toBe(false);
  });

  it('highlight a plan with a free trial', () => {
    const card = toPlanCard({ ...base, priceMonthlyXof: 2000, trialDays: 14 }, tEn, options);
    expect(card.featured).toBe(true);
    expect(card.badge).toBe('14-day free trial');
  });

  it('list the quotas of the grid', () => {
    expect(planFeatures(base, tFr).map(nbsp)).toEqual([
      '3 projets',
      '1 collaborateur par projet',
      '100 Mo de stockage',
      'Historique des versions : 24 h',
      "Compilations jusqu'à 20 s",
      '30 compilations par heure',
      'Priorité de compilation basse',
    ]);
    expect(
      planFeatures(
        {
          ...team,
          minSeats: 10,
          maxSeats: null,
          supervisionDashboard: true,
          maxSupervisedStudents: 30,
        },
        tEn,
      ),
    ).toEqual([
      '10 seats or more, owner included',
      'Unlimited projects',
      'Unlimited collaborators',
      '5 GB of storage per seat',
      'Unlimited version history',
      'Compiles up to 4 min',
      '30 compiles per hour',
      'Automatic compilation',
      'High compile priority',
      'Supervision dashboard (30 students per supervisor)',
    ]);
  });
});
