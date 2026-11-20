import { describe, expect, it } from 'vitest';
import { dateOrder, dueFromInput, dueInputOf } from './dates';

describe('deadline fields', () => {
  it('orders the date as the language does', () => {
    expect(dateOrder('fr')).toEqual({ order: ['day', 'month', 'year'], separator: '/' });
    expect(dateOrder('en').order).toEqual(['month', 'day', 'year']);
  });

  it('shows and reads a deadline in the time zone of the dates shown', () => {
    // 17:00 UTC is 17:00 in Ouagadougou and 18:00 in Douala.
    const iso = '2026-12-20T17:00:00.000Z';
    expect(dueInputOf(iso, 'fr', 'Africa/Ouagadougou')).toEqual({
      date: '20/12/2026',
      time: '17:00',
    });
    expect(dueInputOf(iso, 'fr', 'Africa/Douala')).toEqual({ date: '20/12/2026', time: '18:00' });
    expect(dueInputOf(iso, 'en', 'Africa/Douala')).toEqual({ date: '12/20/2026', time: '18:00' });
    expect(dueFromInput({ date: '20/12/2026', time: '18:00' }, 'fr', 'Africa/Douala')).toBe(iso);
    expect(dueFromInput({ date: '12/20/2026', time: '17:00' }, 'en', 'UTC')).toBe(iso);
    // Around a change of hour (Paris, last Sunday of March).
    expect(dueFromInput({ date: '29/03/2026', time: '12:00' }, 'fr', 'Europe/Paris')).toBe(
      '2026-03-29T10:00:00.000Z',
    );
  });

  it('takes the end of the day without a time, and refuses dates that do not exist', () => {
    expect(dueFromInput({ date: '1/2/2027', time: '' }, 'fr', 'UTC')).toBe(
      '2027-02-01T23:59:00.000Z',
    );
    expect(dueFromInput({ date: '', time: '' }, 'fr', 'UTC')).toBeNull();
    for (const input of [
      { date: '31/02/2027', time: '' },
      { date: '12/31/2027', time: '' },
      { date: '20/12/27', time: '' },
      { date: '20/12/2027', time: '25:00' },
      { date: '', time: '10:00' },
    ]) {
      expect(dueFromInput(input, 'fr', 'UTC')).toBe('invalid');
    }
  });
});
