import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiConfig } from '../config/api-config.js';
import { LigdicashSmsSender } from '../sms/ligdicash-sms-sender.js';
import { SmsError } from '../sms/sms-sender.js';
import { SubmissionRemindersService } from '../submissions/submission-reminders.service.js';
import { type BillingTestApp, createBillingTestApp } from '../test/billing-app.js';
import { TEST_USER_HEADER } from '../test/projects-app.js';
import { NotificationQueue } from './notification-queue.service.js';
import { NotificationsService } from './notifications.service.js';

const DAY_MS = 86_400_000;
const ORIGIN = 'http://127.0.0.1:3000';

let t: BillingTestApp;
let notifications: NotificationsService;
let queue: NotificationQueue;
type Row = Record<string, unknown>;
let user: Row;

beforeAll(async () => {
  t = await createBillingTestApp(
    { NOTIFY_SMS_PER_USER_PER_DAY: '2' },
    [],
    [
      // The deadline reminders are tested on their own (no submissions module here).
    ],
  );
  notifications = t.app.get(NotificationsService);
  queue = t.app.get(NotificationQueue);
});

afterAll(async () => {
  await t.app.close();
});

beforeEach(async () => {
  t.db.reset();
  t.db.addPlans();
  t.outbox.sms = [];
  t.outbox.mails = [];
  queue.pending.splice(0);
  user = t.db.addUser({
    phone: '+22670000002',
    email: 'awa@example.com',
    emailVerifiedAt: new Date(),
  });
});

const as = (who: Row) => {
  const server = t.app.getHttpServer();
  const headers = (req: request.Test) =>
    req.set(TEST_USER_HEADER, who.id as string).set('Origin', ORIGIN);
  return {
    get: (path: string) => headers(request(server).get(`/api${path}`)),
    post: (path: string, body: object = {}) =>
      headers(request(server).post(`/api${path}`)).send(body),
    put: (path: string, body: object) => headers(request(server).put(`/api${path}`)).send(body),
  };
};

describe('delivery', () => {
  it('writes the in-app notice, queues the SMS of SMS types, and sends each once', async () => {
    const payload = {
      submissionId: 's1',
      projectId: 'p1',
      title: 'Chapitre 2 — Méthodologie',
      number: 1,
    };
    const fresh = await notifications.notify(null, [user.id as string], {
      type: 'SUBMISSION_RECEIVED',
      payload,
      key: 'submission-received:v1',
    });
    expect(fresh).toEqual([user.id]);
    expect(
      await notifications.notify(null, [user.id as string], {
        type: 'SUBMISSION_RECEIVED',
        payload,
        key: 'submission-received:v1',
      }),
    ).toEqual([]);
    expect(t.db.rows('notification').map((row) => row.channel)).toEqual(['IN_APP', 'SMS']);
    await queue.flush();
    await queue.flush();
    expect(t.outbox.sms).toHaveLength(1);
    // Short and without confidential data: no title, a link to the notification centre.
    expect(t.outbox.sms[0]!.text).not.toContain('Méthodologie');
    expect(t.outbox.sms[0]!.text).toContain('/fr/app/notifications');
    expect(t.outbox.sms[0]!.text.length).toBeLessThanOrEqual(160);
    expect(t.db.rows('notification', { channel: 'SMS' })[0]!.sentAt).toBeInstanceOf(Date);
  });

  it('sends no SMS for in-app types, and an e-mail only for the categories chosen', async () => {
    await notifications.notify(null, [user.id as string], {
      type: 'QUOTA_ALERT',
      payload: { quota: 'storage', level: 'warn', used: 80, max: 100, month: '2026-11' },
    });
    expect(t.db.rows('notification').map((row) => row.channel)).toEqual(['IN_APP']);
    user.emailNotifications = ['QUOTA'];
    await notifications.notify(null, [user.id as string], {
      type: 'QUOTA_ALERT',
      payload: { quota: 'storage', level: 'full', used: 100, max: 100, month: '2026-11' },
    });
    await queue.flush();
    expect(t.outbox.mails).toHaveLength(1);
    expect(t.outbox.mails[0]!.to).toBe('awa@example.com');
    expect(t.outbox.sms).toHaveLength(0);
    // Unverified address: never.
    user.emailVerifiedAt = null;
    await notifications.notify(null, [user.id as string], {
      type: 'QUOTA_ALERT',
      payload: { quota: 'projects', level: 'full', used: 3, max: 3, month: '2026-11' },
    });
    expect(t.db.rows('notification', { channel: 'EMAIL' })).toHaveLength(1);
  });

  it('keeps to the SMS limit per user and per day; beyond it only the in-app notice', async () => {
    for (const key of ['a', 'b', 'c']) {
      await notifications.notify(null, [user.id as string], {
        type: 'SUBMISSION_FEEDBACK',
        payload: { submissionId: key, projectId: 'p', title: null, number: 1 },
        key,
      });
    }
    await queue.flush();
    expect(t.outbox.sms).toHaveLength(2);
    expect(t.db.rows('notification', { channel: 'SMS', skipped: 'user_limit' })).toHaveLength(1);
    expect(t.db.rows('notification', { channel: 'IN_APP' })).toHaveLength(3);
  });

  it('gives up a failing SMS after its attempt and never notifies a disabled account', async () => {
    const send = vi.spyOn(t.outbox, 'send').mockRejectedValueOnce(new Error('gateway down'));
    await notifications.notify(null, [user.id as string], {
      type: 'SUBMISSION_VALIDATED',
      payload: { submissionId: 's', projectId: 'p', title: null, number: 1 },
    });
    await queue.flush();
    send.mockRestore();
    expect(t.db.rows('notification', { channel: 'SMS' })[0]!.failedAt).toBeInstanceOf(Date);
    user.disabledAt = new Date();
    expect(
      await notifications.notify(null, [user.id as string], {
        type: 'SUBMISSION_VALIDATED',
        payload: { submissionId: 's2', projectId: 'p', title: null, number: 1 },
      }),
    ).toEqual([]);
  });
});

describe('notification centre', () => {
  it('lists, counts, marks as read and keeps the e-mail preferences', async () => {
    for (const type of ['PRINT_READY', 'ORG_JOIN_APPROVED'] as const) {
      await notifications.notify(null, [user.id as string], {
        type,
        payload: { name: 'Université' },
      });
    }
    const other = t.db.addUser({ displayName: 'Autre' });
    await notifications.notify(null, [other.id as string], { type: 'PRINT_READY', payload: {} });
    const page = (await as(user).get('/notifications').expect(200)).body;
    expect(page.items).toHaveLength(2);
    expect(page.unread).toBe(2);
    await as(user)
      .post('/notifications/read', { ids: [page.items[0].id] })
      .expect(204);
    expect((await as(user).get('/notifications/unread').expect(200)).body.unread).toBe(1);
    // Another user's notification is never marked.
    const foreign = t.db.rows('notification', { userId: other.id })[0]!;
    await as(user)
      .post('/notifications/read', { ids: [foreign.id] })
      .expect(204);
    expect(foreign.readAt).toBeNull();
    await as(user).post('/notifications/read-all').expect(204);
    expect((await as(user).get('/notifications/unread').expect(200)).body.unread).toBe(0);

    expect((await as(user).get('/notifications/preferences').expect(200)).body).toEqual({
      email: [],
      emailAvailable: true,
    });
    const saved = await as(user).put('/notifications/preferences', {
      email: ['SUPERVISION', 'PRINT'],
    });
    expect(saved.body.email).toEqual(['SUPERVISION', 'PRINT']);
    await as(user)
      .put('/notifications/preferences', { email: ['SPAM'] })
      .expect(400);
  });
});

describe('deadline reminders', () => {
  it('tells the author and the supervisors among the reviewers 2 days before, once', async () => {
    const supervisor = t.db.addUser({ displayName: 'Encadrant', phone: '+22670000003' });
    const reviewer = t.db.addUser({ displayName: 'Relecteur', phone: '+22670000004' });
    const project = t.db.insert('project', { ownerId: user.id, name: 'Mémoire' });
    for (const [member, role] of [
      [supervisor, 'SUPERVISOR'],
      [reviewer, 'REVIEWER'],
    ] as const) {
      t.db.insert('projectMember', { projectId: project.id, userId: member.id, role });
    }
    const submission = t.db.insert('submission', {
      projectId: project.id,
      authorId: user.id,
      status: 'SUBMITTED',
      dueAt: new Date(Date.now() + 1.5 * DAY_MS),
    });
    for (const member of [supervisor, reviewer]) {
      t.db.insert('submissionReviewer', { submissionId: submission.id, reviewerId: member.id });
    }
    const reminders = new SubmissionRemindersService(
      t.db as never,
      { client: null } as never,
      notifications,
      { env: { NODE_ENV: 'test' } } as ApiConfig,
    );
    expect(await reminders.remind()).toBe(2);
    expect(await reminders.remind()).toBe(0);
    await queue.flush();
    expect(t.outbox.sms.map((sms) => sms.to).sort()).toEqual(['+22670000002', '+22670000003']);
    // A new deadline is told again; a validated submission is not.
    submission.dueAt = new Date(Date.now() + DAY_MS);
    expect(await reminders.remind()).toBe(2);
    submission.status = 'VALIDATED';
    submission.dueAt = new Date(Date.now() + 0.5 * DAY_MS);
    expect(await reminders.remind()).toBe(0);
  });
});

describe('LigdiCash SMS API', () => {
  const config = {
    env: {
      LIGDICASH_SMS_API_URL: 'https://sms.ligdicash.io',
      LIGDICASH_SMS_USER: 'integris',
      LIGDICASH_SMS_API_KEY: 'key',
      LIGDICASH_SMS_TOKEN: 'token',
    },
  } as unknown as ApiConfig;
  const answer = (body: unknown, status = 200) =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));

  afterEach(() => vi.restoreAllMocks());

  it('sends the number without "+", the text and the credentials', async () => {
    const fetch = answer({ success: 100, data: { message_id: 'MSG_1' } });
    await new LigdicashSmsSender(config).send('+22670000002', 'Integris LaTeX : test');
    const [url, init] = fetch.mock.calls[0]! as [URL, RequestInit];
    expect(url.origin + url.pathname).toBe('https://sms.ligdicash.io/api/send_sms.php');
    expect(url.searchParams.get('to')).toBe('22670000002');
    expect(url.searchParams.get('text')).toBe('Integris LaTeX : test');
    expect(url.searchParams.get('api_key')).toBe('key');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('integris:key').toString('base64')}`,
    );
  });

  it('tells permanent refusals from failures worth another attempt', async () => {
    answer({ success: false, error: { code: 1006, message: 'Invalid phone number format' } });
    const invalid = await new LigdicashSmsSender(config).send('+226', 'x').catch((error) => error);
    expect(invalid).toBeInstanceOf(SmsError);
    expect(invalid.permanent).toBe(true);
    vi.restoreAllMocks();
    answer({ success: false, error: { code: 5000, message: 'Internal system error' } });
    const later = await new LigdicashSmsSender(config)
      .send('+22670000002', 'x')
      .catch((error) => error);
    expect(later.permanent).toBe(false);
  });
});
