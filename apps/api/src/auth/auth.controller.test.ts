import { SESSION_COOKIE } from '@integris/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { devMailKey } from '../mail/log-mail-sender.js';
import { devSmsKey } from '../sms/log-sms-sender.js';
import { type AuthTestApp, createAuthTestApp, ORIGIN, solveCaptcha } from '../test/auth-app.js';
import { PasswordService } from './password.service.js';

const PHONE = '+22670123456';
const LOCAL = { phone: '70 12 34 56', dialCode: '226' };

describe('auth API', () => {
  let ctx: AuthTestApp;
  let ipCounter = 0;
  // Each test gets its own IP so the per-IP counters of one test never affect another.
  let ip: string;

  const post = (path: string, body: object, cookie?: string) => {
    const req = request(ctx.app.getHttpServer())
      .post(`/api/auth/${path}`)
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', ip)
      .send(body);
    return cookie ? req.set('Cookie', cookie) : req;
  };
  const get = (path: string, cookie?: string) => {
    const req = request(ctx.app.getHttpServer()).get(`/api/auth/${path}`);
    return cookie ? req.set('Cookie', cookie) : req;
  };

  const lastCode = async (phone = PHONE) => {
    const text = await ctx.redis.client.get(devSmsKey(phone));
    return /\d{6}/.exec(text ?? '')?.[0] ?? '';
  };
  const clearResendDelay = async () => {
    for (const key of await ctx.redis.client.keys('otp:cooldown:*')) {
      await ctx.redis.client.del(key);
    }
  };
  const sessionCookie = (res: request.Response) => {
    const header = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const cookie = header.find((value) => value.startsWith(`${SESSION_COOKIE}=`));
    return cookie?.split(';')[0] ?? '';
  };

  const signup = async () => {
    await post('otp', { ...LOCAL, purpose: 'signup', locale: 'fr' }).expect(200);
    const res = await post('signup', {
      ...LOCAL,
      code: await lastCode(),
      firstName: 'Awa',
      lastName: 'Kaboré',
      acceptTerms: true,
      locale: 'fr',
    }).expect(200);
    return sessionCookie(res);
  };

  beforeAll(async () => {
    ctx = await createAuthTestApp();
    ctx.app.set('trust proxy', true);
  });

  beforeEach(async () => {
    await ctx.redis.client.flushdb();
    ctx.prisma.users = [];
    ctx.prisma.memberships = [];
    ip = `10.1.0.${++ipCounter}`;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  describe('CSRF defence', () => {
    it('refuses a POST without an allowed Origin', async () => {
      await request(ctx.app.getHttpServer())
        .post('/api/auth/otp')
        .send({ ...LOCAL, purpose: 'login', locale: 'fr' })
        .expect(403, { code: 'forbidden_origin' });
      await request(ctx.app.getHttpServer())
        .post('/api/auth/otp')
        .set('Origin', 'https://evil.example')
        .send({ ...LOCAL, purpose: 'login', locale: 'fr' })
        .expect(403);
    });

    it('refuses a form-encoded body', async () => {
      await request(ctx.app.getHttpServer())
        .post('/api/auth/otp')
        .set('Origin', ORIGIN)
        .type('form')
        .send({ phone: '70123456' })
        .expect(403);
    });
  });

  describe('sign-up and sign-in by SMS code', () => {
    it('creates the account, signs in and sets a __Host- session cookie', async () => {
      await post('otp', { ...LOCAL, purpose: 'signup', locale: 'fr' }).expect(200, {
        resendAfter: 60,
      });
      const res = await post('signup', {
        ...LOCAL,
        code: await lastCode(),
        firstName: 'Awa',
        lastName: 'Kaboré',
        acceptTerms: true,
        locale: 'fr',
      }).expect(200);

      expect(res.headers['cache-control']).toBe('no-store');
      const header = ([] as string[]).concat(res.headers['set-cookie'] ?? []).join(';');
      expect(header).toMatch(/^__Host-session=[\w-]{43};/);
      expect(header).toMatch(/Path=\//);
      expect(header).toMatch(/HttpOnly/);
      expect(header).toMatch(/Secure/);
      expect(header).toMatch(/SameSite=Lax/);
      expect(header).not.toMatch(/Domain=/i);
      expect(res.body.user).toMatchObject({ displayName: 'Awa Kaboré', phone: PHONE });
      expect(res.body.currentSpaceId).toBe('personal');
      expect(ctx.prisma.users[0]?.phoneVerifiedAt).toBeInstanceOf(Date);

      const me = await get('me', sessionCookie(res)).expect(200);
      expect(me.body.user.id).toBe(ctx.prisma.users[0]?.id);
    });

    it('signs in with a code and refuses unknown numbers only after the code', async () => {
      await post('otp', { ...LOCAL, purpose: 'login', locale: 'en' }).expect(200);
      expect(await ctx.redis.client.get(devSmsKey(PHONE))).toMatch(/^Integris LaTeX: your code/);
      await post('login/otp', { ...LOCAL, code: await lastCode() }).expect(404, {
        code: 'no_account',
      });

      ctx.prisma.addUser({ phone: PHONE });
      await clearResendDelay();
      await post('otp', { ...LOCAL, purpose: 'login', locale: 'fr' }).expect(200);
      const res = await post('login/otp', { ...LOCAL, code: await lastCode() }).expect(200);
      expect(sessionCookie(res)).not.toBe('');
    });

    it('answers the code request the same way whether the account exists or not', async () => {
      const unknown = await post('otp', { ...LOCAL, purpose: 'login', locale: 'fr' });
      ctx.prisma.addUser({ phone: '+22670123457' });
      const known = await post('otp', {
        phone: '70123457',
        dialCode: '226',
        purpose: 'login',
        locale: 'fr',
      });
      expect(known.status).toBe(unknown.status);
      expect(known.body).toEqual(unknown.body);
    });

    it('refuses numbers of countries that are not allowed, and invalid numbers', async () => {
      await post('otp', {
        phone: '202 555 0143',
        dialCode: '1',
        purpose: 'signup',
        locale: 'fr',
      }).expect(403, { code: 'country_not_allowed' });
      await post('otp', {
        phone: '12345',
        dialCode: '226',
        purpose: 'signup',
        locale: 'fr',
      }).expect(400, { code: 'invalid_phone' });
    });

    it('enforces the resend delay', async () => {
      await post('otp', { ...LOCAL, purpose: 'login', locale: 'fr' }).expect(200);
      const res = await post('otp', { ...LOCAL, purpose: 'login', locale: 'fr' }).expect(429);
      expect(res.body.code).toBe('rate_limited');
      expect(res.body.retryAfter).toBeGreaterThan(55);
    });

    it('blocks the 4th code sent to a number within 15 minutes', async () => {
      for (let i = 0; i < 3; i++) {
        await post('otp', { ...LOCAL, purpose: 'login', locale: 'fr' }).expect(200);
        await clearResendDelay();
      }
      await post('otp', { ...LOCAL, purpose: 'login', locale: 'fr' }).expect(429);
    });

    it('accepts a code once', async () => {
      ctx.prisma.addUser({ phone: PHONE });
      await post('otp', { ...LOCAL, purpose: 'login', locale: 'fr' }).expect(200);
      const code = await lastCode();
      await post('login/otp', { ...LOCAL, code }).expect(200);
      await post('login/otp', { ...LOCAL, code }).expect(400, { code: 'code_expired' });
    });

    it('does not accept a sign-up code to sign in', async () => {
      ctx.prisma.addUser({ phone: PHONE });
      await post('otp', { ...LOCAL, purpose: 'signup', locale: 'fr' }).expect(200);
      await post('login/otp', { ...LOCAL, code: await lastCode() }).expect(400, {
        code: 'code_expired',
      });
    });

    it('expires a code', async () => {
      ctx.prisma.addUser({ phone: PHONE });
      await post('otp', { ...LOCAL, purpose: 'login', locale: 'fr' }).expect(200);
      const code = await lastCode();
      for (const key of await ctx.redis.client.keys('otp:login:*')) {
        await ctx.redis.client.del(key);
      }
      await post('login/otp', { ...LOCAL, code }).expect(400, { code: 'code_expired' });
    });

    it('invalidates a code after 5 wrong attempts, with a CAPTCHA from the 4th', async () => {
      ctx.prisma.addUser({ phone: PHONE });
      await post('otp', { ...LOCAL, purpose: 'login', locale: 'fr' }).expect(200);
      const code = await lastCode();
      const wrong = code === '000000' ? '111111' : '000000';

      for (let i = 0; i < 3; i++) {
        await post('login/otp', { ...LOCAL, code: wrong }).expect(400, { code: 'invalid_code' });
      }
      await post('login/otp', { ...LOCAL, code: wrong }).expect(428, { code: 'captcha_required' });
      await post('login/otp', {
        ...LOCAL,
        code: wrong,
        captcha: await solveCaptcha(ctx.app, { action: 'login_otp', ...LOCAL }),
      }).expect(400, { code: 'invalid_code' });
      await post('login/otp', {
        ...LOCAL,
        code: wrong,
        captcha: await solveCaptcha(ctx.app, { action: 'login_otp', ...LOCAL }),
      }).expect(400, { code: 'too_many_attempts' });
      await post('login/otp', {
        ...LOCAL,
        code,
        captcha: await solveCaptcha(ctx.app, { action: 'login_otp', ...LOCAL }),
      }).expect(400, { code: 'code_expired' });
    });

    it('refuses a CAPTCHA solution used twice or forged', async () => {
      ctx.prisma.addUser({ phone: PHONE });
      await post('otp', { ...LOCAL, purpose: 'login', locale: 'fr' }).expect(200);
      for (let i = 0; i < 3; i++) await post('login/otp', { ...LOCAL, code: `99999${i}` });
      const captcha = await solveCaptcha(ctx.app, { action: 'login_otp', ...LOCAL });
      await post('login/otp', { ...LOCAL, code: '999999', captcha });
      await post('login/otp', { ...LOCAL, code: '999999', captcha }).expect(428, {
        code: 'captcha_invalid',
      });
      await post('login/otp', {
        ...LOCAL,
        code: '999999',
        captcha: Buffer.from('{"challenge":{},"solution":{}}').toString('base64'),
      }).expect(428, { code: 'captcha_invalid' });
    });

    it('refuses a CAPTCHA solved for another number, another action or with altered data', async () => {
      ctx.prisma.addUser({ phone: PHONE });
      await post('otp', { ...LOCAL, purpose: 'login', locale: 'fr' }).expect(200);
      for (let i = 0; i < 3; i++) await post('login/otp', { ...LOCAL, code: `99999${i}` });
      const refused = { code: 'captcha_invalid' };

      const otherNumber = await solveCaptcha(ctx.app, {
        action: 'login_otp',
        phone: '70123457',
        dialCode: '226',
      });
      await post('login/otp', { ...LOCAL, code: '999999', captcha: otherNumber }).expect(
        428,
        refused,
      );

      const otherAction = await solveCaptcha(ctx.app, { action: 'signup', ...LOCAL });
      await post('login/otp', { ...LOCAL, code: '999999', captcha: otherAction }).expect(
        428,
        refused,
      );

      const valid = await solveCaptcha(ctx.app, {
        action: 'login_otp',
        phone: '70123457',
        dialCode: '226',
      });
      const decoded = JSON.parse(Buffer.from(valid, 'base64').toString('utf8'));
      decoded.challenge.parameters.data.target = JSON.parse(
        Buffer.from(
          await solveCaptcha(ctx.app, { action: 'login_otp', ...LOCAL }),
          'base64',
        ).toString('utf8'),
      ).challenge.parameters.data.target;
      const altered = Buffer.from(JSON.stringify(decoded)).toString('base64');
      await post('login/otp', { ...LOCAL, code: '999999', captcha: altered }).expect(428, refused);
    });

    it('applies the configured difficulty', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/api/auth/captcha')
        .set('Origin', ORIGIN)
        .send({ action: 'otp', ...LOCAL })
        .expect(200);
      expect(res.body.parameters).toMatchObject({ keyPrefix: '0', cost: 1 });
      expect(JSON.stringify(res.body)).not.toContain('70123456');
    });

    it('locks the number for 15 minutes after 10 failures', async () => {
      ctx.prisma.addUser({ phone: PHONE });
      for (let round = 0; round < 2; round++) {
        await clearResendDelay();
        await post('otp', {
          ...LOCAL,
          purpose: 'login',
          locale: 'fr',
          captcha: round ? await solveCaptcha(ctx.app, { action: 'otp', ...LOCAL }) : undefined,
        }).expect(200);
        for (let i = 0; i < 5; i++) {
          await post('login/otp', {
            ...LOCAL,
            code: '999999',
            captcha: await solveCaptcha(ctx.app, { action: 'login_otp', ...LOCAL }),
          });
        }
      }
      const res = await post('login/otp', { ...LOCAL, code: '999999' }).expect(429);
      expect(res.body.code).toBe('locked');
      expect(res.body.retryAfter).toBeGreaterThan(890);
    });

    it('signs an existing number in to its own account at sign-up', async () => {
      const owner = ctx.prisma.addUser({ phone: PHONE, displayName: 'Original Name' });
      await signup();
      expect(ctx.prisma.users).toHaveLength(1);
      expect(ctx.prisma.users[0]).toMatchObject({ id: owner.id, displayName: 'Original Name' });
    });

    it('refuses disabled accounts', async () => {
      ctx.prisma.addUser({ phone: PHONE, disabledAt: new Date() });
      await post('otp', { ...LOCAL, purpose: 'login', locale: 'fr' }).expect(200);
      await post('login/otp', { ...LOCAL, code: await lastCode() }).expect(403, {
        code: 'account_disabled',
      });
    });
  });

  describe('sessions', () => {
    it('signs out and refuses the old cookie', async () => {
      const cookie = await signup();
      await post('logout', {}, cookie).expect(204);
      await get('me', cookie).expect(401, { code: 'unauthenticated' });
    });

    it('refuses a session past its absolute lifetime', async () => {
      const cookie = await signup();
      const [key] = await ctx.redis.client.keys('sess:*');
      const data = JSON.parse((await ctx.redis.client.get(key!))!);
      await ctx.redis.client.set(
        key!,
        JSON.stringify({ ...data, absoluteExpiresAt: Math.floor(Date.now() / 1000) - 1 }),
      );
      await get('me', cookie).expect(401);
      expect(await ctx.redis.client.exists(key!)).toBe(0);
    });

    it('slides the idle lifetime, capped at 30 days', async () => {
      await signup();
      const [key] = await ctx.redis.client.keys('sess:*');
      const ttl = await ctx.redis.client.ttl(key!);
      expect(ttl).toBeGreaterThan(30 * 86_400 - 10);
      expect(ttl).toBeLessThanOrEqual(30 * 86_400);
    });

    it('stores only a hash of the session id', async () => {
      const cookie = await signup();
      const id = cookie.split('=')[1]!;
      const keys = await ctx.redis.client.keys('*');
      expect(keys.join(' ')).not.toContain(id);
    });

    it('signs out every device', async () => {
      const first = await signup();
      await clearResendDelay();
      await post('otp', { ...LOCAL, purpose: 'login', locale: 'fr' }).expect(200);
      const second = sessionCookie(
        await post('login/otp', { ...LOCAL, code: await lastCode() }).expect(200),
      );
      await post('logout-all', {}, second).expect(204);
      await get('me', first).expect(401);
      await get('me', second).expect(401);
    });

    it('closes the previous session of the browser at a new sign-in', async () => {
      const first = await signup();
      await clearResendDelay();
      await post('otp', { ...LOCAL, purpose: 'login', locale: 'fr' }).expect(200);
      await post('login/otp', { ...LOCAL, code: await lastCode() }, first).expect(200);
      await get('me', first).expect(401);
    });

    it('refuses a forged cookie', async () => {
      await get('me', `${SESSION_COOKIE}=forged`).expect(401);
      await get('me').expect(401);
    });
  });

  describe('spaces', () => {
    const addMembership = (userId: string, orgId: string, status = 'ACTIVE') => {
      ctx.prisma.memberships.push({
        id: `m-${orgId}`,
        organizationId: orgId,
        userId,
        role: 'MEMBER',
        kind: 'TEACHER',
        status: status as 'ACTIVE',
        approvedById: null,
        approvedAt: null,
        groupId: null,
        teacherRequestedAt: null,
        createdAt: new Date(),
        organization: {
          id: orgId,
          type: 'BUSINESS',
          name: `Org ${orgId}`,
          ifu: null,
          joinCode: null,
          membersChooseGroup: false,
          pilotTrialStartedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
    };

    it('asks to choose when the user has several spaces, then switches without signing in', async () => {
      const user = ctx.prisma.addUser({ phone: PHONE });
      addMembership(user.id, 'org-1');
      addMembership(user.id, 'org-pending', 'PENDING_APPROVAL');
      await post('otp', { ...LOCAL, purpose: 'login', locale: 'fr' }).expect(200);
      const res = await post('login/otp', { ...LOCAL, code: await lastCode() }).expect(200);
      expect(res.body.currentSpaceId).toBeNull();
      expect(res.body.spaces.map((space: { id: string }) => space.id)).toEqual([
        'personal',
        'org-1',
      ]);

      const cookie = sessionCookie(res);
      await post('space', { spaceId: 'org-pending' }, cookie).expect(403, {
        code: 'space_not_allowed',
      });
      await post('space', { spaceId: 'org-other' }, cookie).expect(403);
      const chosen = await post('space', { spaceId: 'org-1' }, cookie).expect(200);
      expect(chosen.body.currentSpaceId).toBe('org-1');
      expect((await get('me', cookie)).body.currentSpaceId).toBe('org-1');
      expect(user.lastSpace).toBe('org-1');
    });

    it('drops the current space when the membership is removed', async () => {
      const user = ctx.prisma.addUser({ phone: PHONE });
      addMembership(user.id, 'org-1');
      addMembership(user.id, 'org-2');
      await post('otp', { ...LOCAL, purpose: 'login', locale: 'fr' }).expect(200);
      const cookie = sessionCookie(
        await post('login/otp', { ...LOCAL, code: await lastCode() }).expect(200),
      );
      await post('space', { spaceId: 'org-1' }, cookie).expect(200);
      ctx.prisma.memberships = ctx.prisma.memberships.filter((m) => m.organizationId !== 'org-1');
      // Two spaces left: the user chooses again.
      expect((await get('me', cookie)).body.currentSpaceId).toBeNull();
      // A single space left opens by itself (never a loop between /app and /spaces).
      ctx.prisma.memberships = [];
      expect((await get('me', cookie)).body.currentSpaceId).toBe('personal');
    });
  });

  describe('e-mail and password', () => {
    /** Confirms the identity with a code sent to the account phone (10 minutes). */
    const reauth = async (cookie: string) => {
      await clearResendDelay();
      await post('reauth/otp', { locale: 'fr' }, cookie).expect(200);
      const res = await post('reauth', { code: await lastCode() }, cookie).expect(200);
      return res.body.reauthUntil as number;
    };
    const signupReauthed = async (): Promise<string> => {
      const cookie = await signup();
      await reauth(cookie);
      return cookie;
    };

    const verifyEmail = async (cookie: string, email: string) => {
      await post('email', { email, locale: 'fr' }, cookie).expect(204);
      const mail = (await ctx.redis.client.get(devMailKey(email))) ?? '';
      const token = /#token=([\w-]+)/.exec(mail)?.[1] ?? '';
      await post('email/verify', { token }).expect(204);
      return token;
    };

    it('confirms an e-mail address once, then allows setting a password', async () => {
      const cookie = await signupReauthed();
      await post('password', { newPassword: 'kaboré-thèse-2026' }, cookie).expect(400, {
        code: 'email_required',
      });

      await post('email', { email: 'Awa@Example.com', locale: 'fr' }, cookie).expect(204);
      expect((await get('me', cookie)).body.user).toMatchObject({
        email: null,
        pendingEmail: 'awa@example.com',
      });
      const mail = (await ctx.redis.client.get(devMailKey('awa@example.com'))) ?? '';
      expect(mail).toContain('/fr/verify-email#token=');
      const token = /#token=([\w-]+)/.exec(mail)?.[1] ?? '';
      await post('email/verify', { token }).expect(204);
      await post('email/verify', { token }).expect(400, { code: 'invalid_token' });
      expect((await get('me', cookie)).body.user).toMatchObject({
        email: 'awa@example.com',
        pendingEmail: null,
      });

      await post('password', { newPassword: 'short' }, cookie).expect(400, {
        code: 'weak_password',
      });
      await post('password', { newPassword: 'Password123' }, cookie).expect(400, {
        code: 'common_password',
      });
      await post('password', { newPassword: 'kaboré-thèse-2026' }, cookie).expect(204);
      expect(ctx.prisma.users[0]?.passwordHash).toMatch(/^\$argon2id\$/);
    });

    it('keeps only the latest confirmation link valid', async () => {
      const cookie = await signupReauthed();
      await post('email', { email: 'typo@example.com', locale: 'fr' }, cookie).expect(204);
      const old = /#token=([\w-]+)/.exec(
        (await ctx.redis.client.get(devMailKey('typo@example.com'))) ?? '',
      )?.[1];
      await post('email', { email: 'awa@example.com', locale: 'fr' }, cookie).expect(204);
      await post('email/verify', { token: old }).expect(400, { code: 'invalid_token' });
      expect((await get('me', cookie)).body.user.email).toBeNull();
    });

    it('refuses an e-mail address already confirmed by another account', async () => {
      ctx.prisma.addUser({ email: 'taken@example.com', emailVerifiedAt: new Date() });
      const cookie = await signupReauthed();
      await post('email', { email: 'taken@example.com', locale: 'fr' }, cookie).expect(204);
      const mail = (await ctx.redis.client.get(devMailKey('taken@example.com'))) ?? '';
      const token = /#token=([\w-]+)/.exec(mail)?.[1] ?? '';
      await post('email/verify', { token }).expect(409, { code: 'email_taken' });
    });

    it('signs in with e-mail and password, with one generic error', async () => {
      const hash = await ctx.app.get(PasswordService).hash('kaboré-thèse-2026');
      ctx.prisma.addUser({
        phone: PHONE,
        email: 'awa@example.com',
        emailVerifiedAt: new Date(),
        passwordHash: hash,
      });
      await post('login/password', {
        email: 'awa@example.com',
        password: 'wrong-password',
      }).expect(401, { code: 'invalid_credentials' });
      await post('login/password', {
        email: 'nobody@example.com',
        password: 'kaboré-thèse-2026',
      }).expect(401, { code: 'invalid_credentials' });
      const res = await post('login/password', {
        email: 'AWA@example.com',
        password: 'kaboré-thèse-2026',
      }).expect(200);
      expect(sessionCookie(res)).not.toBe('');
    });

    it('requires a CAPTCHA after 3 wrong passwords', async () => {
      for (let i = 0; i < 3; i++) {
        await post('login/password', { email: 'a@example.com', password: 'wrong' }).expect(401);
      }
      await post('login/password', { email: 'a@example.com', password: 'wrong' }).expect(428);
      await post('login/password', {
        email: 'a@example.com',
        password: 'wrong',
        captcha: await solveCaptcha(ctx.app, { action: 'login_password', email: 'a@example.com' }),
      }).expect(401);
    });

    it('refuses the password of an unconfirmed address', async () => {
      const hash = await ctx.app.get(PasswordService).hash('kaboré-thèse-2026');
      ctx.prisma.addUser({ email: 'awa@example.com', passwordHash: hash });
      await post('login/password', {
        email: 'awa@example.com',
        password: 'kaboré-thèse-2026',
      }).expect(401);
    });

    it('changes the password after reauthentication and signs out other sessions', async () => {
      const cookie = await signupReauthed();
      await verifyEmail(cookie, 'awa@example.com');
      await post('password', { newPassword: 'kaboré-thèse-2026' }, cookie).expect(204);
      const other = sessionCookie(
        await post('login/password', {
          email: 'awa@example.com',
          password: 'kaboré-thèse-2026',
        }).expect(200),
      );
      // The other session has not confirmed its identity by SMS.
      await post('password', { newPassword: 'pris-par-un-autre-2027' }, other).expect(403, {
        code: 'reauth_required',
      });
      await post('password', { newPassword: 'nouvelle-phrase-2027' }, cookie).expect(204);
      await get('me', cookie).expect(200);
      await get('me', other).expect(401);
    });

    it('requires a recent SMS confirmation to change the e-mail or the password', async () => {
      const cookie = await signup();
      expect((await get('me', cookie)).body.reauthUntil).toBeNull();
      await post('email', { email: 'awa@example.com', locale: 'fr' }, cookie).expect(403, {
        code: 'reauth_required',
      });
      await post('password', { newPassword: 'kaboré-thèse-2026' }, cookie).expect(403, {
        code: 'reauth_required',
      });

      // A sign-in code is not a reauthentication code.
      await clearResendDelay();
      await post('otp', { ...LOCAL, purpose: 'login', locale: 'fr' }).expect(200);
      await post('reauth', { code: await lastCode() }, cookie).expect(400, {
        code: 'code_expired',
      });

      const until = await reauth(cookie);
      const now = Math.floor(Date.now() / 1000);
      expect(until).toBeGreaterThanOrEqual(now + 599);
      expect(until).toBeLessThanOrEqual(now + 600);
      expect((await get('me', cookie)).body.reauthUntil).toBe(until);
      await post('email', { email: 'awa@example.com', locale: 'fr' }, cookie).expect(204);

      // After 10 minutes the confirmation is no longer valid.
      const [key] = await ctx.redis.client.keys('sess:*');
      const data = JSON.parse((await ctx.redis.client.get(key!))!);
      await ctx.redis.client.set(key!, JSON.stringify({ ...data, reauthUntil: now - 1 }));
      await post('email', { email: 'other@example.com', locale: 'fr' }, cookie).expect(403, {
        code: 'reauth_required',
      });
      expect((await get('me', cookie)).body.reauthUntil).toBeNull();
    });

    it('revokes pending reset and confirmation links when the account e-mail changes', async () => {
      const cookie = await signupReauthed();
      await verifyEmail(cookie, 'awa@example.com');
      await post('password/forgot', { email: 'awa@example.com', locale: 'fr' }).expect(204);
      const reset = /#token=([\w-]+)/.exec(
        (await ctx.redis.client.get(devMailKey('awa@example.com'))) ?? '',
      )?.[1];

      await post('email', { email: 'nouvelle@example.com', locale: 'fr' }, cookie).expect(204);
      await verifyEmail(cookie, 'awa.k@example.com');
      // The reset link sent to the previous address no longer works.
      await post('password/reset', { token: reset, newPassword: 'pris-par-un-autre-2027' }).expect(
        400,
        { code: 'invalid_token' },
      );
      // Nor the confirmation link of the address that was not confirmed.
      const pending = /#token=([\w-]+)/.exec(
        (await ctx.redis.client.get(devMailKey('nouvelle@example.com'))) ?? '',
      )?.[1];
      await post('email/verify', { token: pending }).expect(400, { code: 'invalid_token' });
      expect((await get('me', cookie)).body.user.email).toBe('awa.k@example.com');
    });

    it('resets a forgotten password by e-mail and signs out every session', async () => {
      const cookie = await signupReauthed();
      await verifyEmail(cookie, 'awa@example.com');

      await post('password/forgot', { email: 'nobody@example.com', locale: 'fr' }).expect(204);
      expect(await ctx.redis.client.get(devMailKey('nobody@example.com'))).toBeNull();
      await post('password/forgot', { email: 'awa@example.com', locale: 'en' }).expect(204);
      const mail = (await ctx.redis.client.get(devMailKey('awa@example.com'))) ?? '';
      expect(mail).toContain('/en/reset-password#token=');
      const token = /#token=([\w-]+)/.exec(mail)?.[1] ?? '';

      await post('password/reset', { token, newPassword: 'short' }).expect(400, {
        code: 'weak_password',
      });
      await post('password/reset', { token, newPassword: 'nouvelle-phrase-2027' }).expect(204);
      await post('password/reset', { token, newPassword: 'nouvelle-phrase-2027' }).expect(400, {
        code: 'invalid_token',
      });
      await get('me', cookie).expect(401);
      await post('login/password', {
        email: 'awa@example.com',
        password: 'nouvelle-phrase-2027',
      }).expect(200);
    });
  });

  describe('preferences', () => {
    const patch = (body: object, cookie?: string) => {
      const req = request(ctx.app.getHttpServer())
        .patch('/api/auth/preferences')
        .set('Origin', ORIGIN)
        .set('X-Forwarded-For', ip)
        .send(body);
      return cookie ? req.set('Cookie', cookie) : req;
    };

    it('keeps the spell checker of the editor off until the user turns it on', async () => {
      const cookie = await signup();
      const before = await get('me', cookie).expect(200);
      expect(before.body.user.preferences).toEqual({ editorSpellcheck: false });

      await patch({ editorSpellcheck: true }, cookie).expect(200, { editorSpellcheck: true });
      const after = await get('me', cookie).expect(200);
      expect(after.body.user.preferences).toEqual({ editorSpellcheck: true });
    });

    it('requires a session and refuses unknown or invalid settings', async () => {
      await patch({ editorSpellcheck: true }).expect(401);
      const cookie = await signup();
      await patch({}, cookie).expect(400);
      await patch({ editorSpellcheck: 'yes' }, cookie).expect(400);
      await patch({ editorSpellcheck: true, isSuperAdmin: true }, cookie).expect(400);
      expect(ctx.prisma.users[0]!.isSuperAdmin).toBe(false);
    });
  });
});
