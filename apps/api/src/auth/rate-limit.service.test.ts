import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type AuthTestApp, createAuthTestApp } from '../test/auth-app.js';
import { RateLimitService } from './rate-limit.service.js';

describe('RateLimitService', () => {
  let ctx: AuthTestApp;
  let limits: RateLimitService;

  beforeAll(async () => {
    ctx = await createAuthTestApp({ SEND_LIMIT_PER_ID_15MIN: '100' });
    limits = ctx.app.get(RateLimitService);
  });

  beforeEach(async () => {
    await ctx.redis.client.flushdb();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  const sends = async (
    count: number,
    identifier: (i: number) => string,
    ip: (i: number) => string,
  ) => {
    for (let i = 0; i < count; i++) await limits.consumeSend(identifier(i), ip(i));
  };

  it('limits messages per identifier per 15 minutes', async () => {
    const strict = await createAuthTestApp();
    const service = strict.app.get(RateLimitService);
    for (let i = 0; i < 3; i++) await service.consumeSend('+22670000001', `10.0.0.${i}`);
    await expect(service.consumeSend('+22670000001', '10.0.0.9')).rejects.toMatchObject({
      response: { code: 'rate_limited', retryAfter: expect.any(Number) },
    });
    // Another number is not affected.
    await service.consumeSend('+22670000002', '10.0.0.9');
    await strict.app.close();
  });

  it('limits messages per identifier per day', async () => {
    await sends(
      10,
      () => '+22670000001',
      (i) => `10.0.1.${i}`,
    );
    const error = await limits.consumeSend('+22670000001', '10.0.1.99').catch((e: unknown) => e);
    expect(error).toMatchObject({ response: { code: 'rate_limited' } });
    const retryAfter = (error as { response: { retryAfter: number } }).response.retryAfter;
    expect(retryAfter).toBeGreaterThan(3600);
    expect(retryAfter).toBeLessThanOrEqual(86_400);
  });

  it('limits messages per IP per hour', async () => {
    await sends(
      20,
      (i) => `+2267000${String(i).padStart(4, '0')}`,
      () => '10.0.2.1',
    );
    await expect(limits.consumeSend('+22671111111', '10.0.2.1')).rejects.toMatchObject({
      response: { code: 'rate_limited' },
    });
    await limits.consumeSend('+22671111111', '10.0.2.2');
  });

  it('limits messages per IP per day', async () => {
    const wide = await createAuthTestApp({
      SEND_LIMIT_PER_ID_15MIN: '1000',
      SEND_LIMIT_PER_ID_DAY: '1000',
      SEND_LIMIT_PER_IP_HOUR: '1000',
    });
    const service = wide.app.get(RateLimitService);
    for (let i = 0; i < 100; i++) await service.consumeSend(`id-${i}`, '10.0.3.1');
    const error = await service.consumeSend('id-x', '10.0.3.1').catch((e: unknown) => e);
    expect(error).toMatchObject({ response: { code: 'rate_limited' } });
    expect((error as { response: { retryAfter: number } }).response.retryAfter).toBeGreaterThan(
      3600,
    );
    await wide.app.close();
  });

  it('requires a CAPTCHA once 3 attempts of an identifier have failed', async () => {
    for (let i = 0; i < 3; i++) {
      expect(await limits.beginAttempt('+22670000001', `10.0.4.${i}`)).toEqual({
        captchaRequired: false,
      });
    }
    expect(await limits.beginAttempt('+22670000001', '10.0.4.9')).toEqual({
      captchaRequired: true,
    });
  });

  it('requires a CAPTCHA after 3 failures from an IP, whatever the identifier', async () => {
    for (let i = 0; i < 3; i++) await limits.beginAttempt(`+2267000000${i}`, '10.0.5.1');
    expect(await limits.checkAttempt('+22679999999', '10.0.5.1')).toEqual({
      captchaRequired: true,
    });
    expect(await limits.checkAttempt('+22679999999', '10.0.5.2')).toEqual({
      captchaRequired: false,
    });
  });

  it('counts parallel attempts: a burst cannot skip the CAPTCHA or the lock', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, (_, i) => limits.beginAttempt('a@example.com', `10.0.9.${i}`)),
    );
    const allowed = results.filter((result) => result.status === 'fulfilled');
    expect(allowed).toHaveLength(10);
    const withoutCaptcha = allowed.filter(
      (result) =>
        !(result as PromiseFulfilledResult<{ captchaRequired: boolean }>).value.captchaRequired,
    );
    expect(withoutCaptcha).toHaveLength(3);
    await expect(limits.beginAttempt('a@example.com', '10.0.9.99')).rejects.toMatchObject({
      response: { code: 'locked' },
    });
  });

  it('locks an identifier for 15 minutes after 10 failures', async () => {
    for (let i = 0; i < 10; i++) await limits.beginAttempt('+22670000001', `10.0.6.${i}`);
    const error = await limits.checkAttempt('+22670000001', '10.0.6.99').catch((e: unknown) => e);
    expect(error).toMatchObject({ response: { code: 'locked' } });
    const retryAfter = (error as { response: { retryAfter: number } }).response.retryAfter;
    expect(retryAfter).toBeGreaterThan(890);
    expect(retryAfter).toBeLessThanOrEqual(900);
  });

  it('clears the identifier failures and gives back the IP one after a success', async () => {
    for (let i = 0; i < 3; i++) await limits.beginAttempt('+22670000001', '10.0.7.1');
    await limits.succeed('+22670000001', '10.0.7.1');
    expect(await limits.checkAttempt('+22670000001', '10.0.7.2')).toEqual({
      captchaRequired: false,
    });
    // 2 failures left for the IP: below the threshold.
    expect(await limits.checkAttempt('+22671111111', '10.0.7.1')).toEqual({
      captchaRequired: false,
    });
  });

  it('gives back an attempt refused before the check (CAPTCHA missing)', async () => {
    for (let i = 0; i < 3; i++) await limits.beginAttempt('+22670000001', '10.0.7.5');
    await limits.beginAttempt('+22670000001', '10.0.7.5');
    await limits.release('+22670000001', '10.0.7.5');
    const value = await ctx.redis.client.keys('rl:fail:id:*');
    expect(await ctx.redis.client.get(value[0]!)).toBe('3');
  });

  it('shares one bucket per IPv6 /64 and unwraps IPv4-mapped addresses', async () => {
    for (let i = 0; i < 3; i++) await limits.beginAttempt(`id-${i}`, `2001:db8:1:2::${i + 1}`);
    expect(await limits.checkAttempt('other', '2001:db8:1:2:ffff::9')).toEqual({
      captchaRequired: true,
    });
    expect(await limits.checkAttempt('other', '2001:db8:1:3::1')).toEqual({
      captchaRequired: false,
    });
    for (let i = 0; i < 3; i++) await limits.beginAttempt(`v4-${i}`, '::ffff:10.0.10.1');
    expect(await limits.checkAttempt('other', '10.0.10.1')).toEqual({ captchaRequired: true });
  });

  it('never stores identifiers in clear in Redis', async () => {
    await limits.consumeSend('+22670000001', '10.0.8.1');
    await limits.beginAttempt('user@example.com', '10.0.8.1');
    const keys = await ctx.redis.client.keys('*');
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.join(' ')).not.toMatch(/22670000001|example\.com|10\.0\.8\.1/);
  });
});
