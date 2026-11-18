import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type AuthTestApp, createAuthTestApp, ORIGIN } from '../test/auth-app.js';

describe('platform-wide SMS budget', () => {
  let ctx: AuthTestApp;

  beforeAll(async () => {
    ctx = await createAuthTestApp({ SMS_DAILY_LIMIT: '5' });
  });

  afterAll(async () => {
    await ctx.app.close();
    vi.restoreAllMocks();
  });

  const send = (i: number) =>
    request(ctx.app.getHttpServer())
      .post('/api/auth/otp')
      .set('Origin', ORIGIN)
      .send({ phone: `70 00 00 0${i}`, dialCode: '226', purpose: 'signup', locale: 'fr' });

  it('warns at 80 % and refuses codes clearly once the daily budget is used up', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    for (let i = 1; i <= 3; i++) await send(i).expect(200);
    expect(warn).not.toHaveBeenCalled();
    await send(4).expect(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('80 %'));
    await send(5).expect(200);

    await send(6).expect(503, { code: 'sms_unavailable' });
    await send(7).expect(503, { code: 'sms_unavailable' });
    expect(error).toHaveBeenCalledTimes(1);
    expect(await ctx.redis.client.get('dev:sms:+22670000006')).toBeNull();
  });
});
