import { describe, expect, it } from 'vitest';
import {
  compareDashboardRows,
  type DashboardRow,
  formatJoinCode,
  joinOrganizationSchema,
  kindOfCsv,
  normalizeJoinCode,
  parseMembersCsv,
  urgencyOf,
} from './organizations.js';

describe('member CSV', () => {
  it('reads ";" or "," files with accented headers in any order, quotes and blank lines', () => {
    const semicolon =
      'Classe;Nom;Téléphone;Profil\r\nL3;"Ouédraogo; Awa";70 11 11 11;Étudiant\r\n\r\n';
    expect(parseMembersCsv(semicolon)).toEqual([
      {
        line: 2,
        name: 'Ouédraogo; Awa',
        phone: '70 11 11 11',
        email: '',
        kind: 'Étudiant',
        group: 'L3',
      },
    ]);
    const comma = 'name,email,profile\n"Issa ""K""",issa@x.bf,teacher\nAli,ali@x.bf,';
    expect(parseMembersCsv(comma)?.map((row) => [row.line, row.name, row.email])).toEqual([
      [2, 'Issa "K"', 'issa@x.bf'],
      [3, 'Ali', 'ali@x.bf'],
    ]);
  });

  it('refuses a file without a contact column', () => {
    expect(parseMembersCsv('nom;classe\nAwa;L3')).toBeNull();
    expect(parseMembersCsv('')).toBeNull();
  });

  it('reads the profile in French or English', () => {
    expect(kindOfCsv('Étudiant')).toBe('STUDENT');
    expect(kindOfCsv(' ENSEIGNANT ')).toBe('TEACHER');
    expect(kindOfCsv('directeur')).toBeNull();
  });
});

describe('join code', () => {
  it('ignores case, spaces and dashes and reads O, I, L as digits', () => {
    expect(normalizeJoinCode('abcde-fghjk')).toBe('ABCDEFGHJK');
    expect(normalizeJoinCode('o1l2i 3456 7')).toBe('0112134567');
    expect(formatJoinCode('ABCDEFGHJK')).toBe('ABCDE-FGHJK');
    expect(joinOrganizationSchema.safeParse({ code: 'abcde-fghjk' }).success).toBe(true);
    expect(joinOrganizationSchema.safeParse({ code: 'ABCDE-FGHJU' }).success).toBe(false);
  });
});

describe('supervision dashboard order', () => {
  const now = new Date('2026-11-20T12:00:00Z');
  const day = 86_400_000;
  const row = (
    name: string,
    status: string | null,
    due: number | null,
    active: number,
  ): DashboardRow => {
    const submission = status
      ? { status, dueAt: due === null ? null : new Date(now.getTime() + due * day) }
      : null;
    return {
      supervisionId: name,
      student: { id: name, name, group: null },
      project: null,
      submission: submission && {
        id: name,
        title: null,
        status: status as 'SUBMITTED',
        dueAt: submission.dueAt?.toISOString() ?? null,
      },
      submissions: submission ? 1 : 0,
      lastActivityAt: new Date(now.getTime() - active * day).toISOString(),
      urgency: urgencyOf(submission, now),
    };
  };

  it('puts overdue first, then to review, then due soon, then the oldest activity', () => {
    const rows = [
      row('idle-recent', null, null, 1),
      row('due-soon', 'FEEDBACK_SENT', 3, 1),
      row('review', 'REVISED', 20, 1),
      row('idle-old', 'DRAFT', null, 9),
      row('overdue', 'FEEDBACK_SENT', -1, 1),
      row('validated', 'VALIDATED', -5, 1),
    ];
    expect(rows.sort(compareDashboardRows).map((item) => item.supervisionId)).toEqual([
      'overdue',
      'review',
      'due-soon',
      'idle-old',
      'idle-recent',
      'validated',
    ]);
  });
});
