import type { Locale, OtpPurpose } from '@integris/shared';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../common/api-error.js';
import { ApiConfig } from '../config/api-config.js';
import { RedisService } from '../redis/redis.service.js';
import { consumeSmsBudget } from '../sms/sms-budget.js';
import { SMS_SENDER, type SmsSender } from '../sms/sms-sender.js';
import { keyedHash } from './keys.js';
import { RateLimitService } from './rate-limit.service.js';

export type OtpCheck = 'ok' | 'invalid_code' | 'code_expired' | 'too_many_attempts';

const smsText: Record<Locale, (code: string, minutes: number) => string> = {
  // Same text for every purpose: the code is only usable for the action it was requested for.
  fr: (code, minutes) =>
    `Integris LaTeX : votre code est ${code}. Il expire dans ${minutes} min. Ne le communiquez à personne.`,
  en: (code, minutes) =>
    `Integris LaTeX: your code is ${code}. It expires in ${minutes} min. Never share it.`,
};

// Counts one attempt and returns the stored hash, or nothing when no code is pending.
const ATTEMPT_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return false end
local attempts = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
return { redis.call('HGET', KEYS[1], 'hash'), attempts }
`;

/**
 * One-time codes sent by SMS. Codes are stored as a keyed hash, expire, allow a limited number of
 * attempts and are deleted on success, so each code is usable once.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger('SMS');

  constructor(
    private readonly redis: RedisService,
    private readonly config: ApiConfig,
    private readonly limits: RateLimitService,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
  ) {}

  private key(purpose: OtpPurpose, phone: string): string {
    return `otp:${purpose}:${keyedHash(this.config.env.AUTH_SECRET, phone)}`;
  }

  private codeHash(purpose: OtpPurpose, phone: string, code: string): string {
    return keyedHash(this.config.env.AUTH_SECRET, `${purpose}:${phone}:${code}`);
  }

  /** Sends a new code unless the resend delay or a sending limit forbids it. */
  async send(phone: string, purpose: OtpPurpose, locale: Locale, ip: string): Promise<number> {
    const env = this.config.env;
    const cooldownKey = `otp:cooldown:${keyedHash(env.AUTH_SECRET, phone)}`;
    const free = await this.redis.client.set(cooldownKey, '1', 'EX', env.OTP_RESEND_SECONDS, 'NX');
    if (free !== 'OK') {
      const ttl = await this.redis.client.ttl(cooldownKey);
      throw new ApiError(HttpStatus.TOO_MANY_REQUESTS, 'rate_limited', Math.max(ttl, 1));
    }
    await this.limits.consumeSend(phone, ip);
    await consumeSmsBudget(this.redis.client, env.SMS_DAILY_LIMIT, this.logger);

    const code = randomInt(0, 10 ** env.OTP_LENGTH)
      .toString()
      .padStart(env.OTP_LENGTH, '0');
    const key = this.key(purpose, phone);
    await this.redis.client
      .multi()
      .del(key)
      .hset(key, { hash: this.codeHash(purpose, phone, code), attempts: 0 })
      .expire(key, env.OTP_TTL_SECONDS)
      .exec();
    await this.sms.send(phone, smsText[locale](code, Math.ceil(env.OTP_TTL_SECONDS / 60)));
    return env.OTP_RESEND_SECONDS;
  }

  /** Checks a code. A valid code is consumed; the last allowed wrong attempt deletes it. */
  async check(phone: string, purpose: OtpPurpose, code: string): Promise<OtpCheck> {
    const key = this.key(purpose, phone);
    const result = (await this.redis.client.eval(ATTEMPT_SCRIPT, 1, key)) as
      [string, number] | null;
    if (!result) return 'code_expired';
    const [stored, attempts] = result;
    const max = this.config.env.OTP_MAX_ATTEMPTS;
    if (attempts > max) {
      await this.redis.client.del(key);
      return 'too_many_attempts';
    }
    const expected = Buffer.from(stored);
    const given = Buffer.from(this.codeHash(purpose, phone, code));
    if (expected.length === given.length && timingSafeEqual(expected, given)) {
      // DEL returns 0 if a concurrent request already consumed the code.
      return (await this.redis.client.del(key)) === 1 ? 'ok' : 'code_expired';
    }
    if (attempts >= max) {
      await this.redis.client.del(key);
      return 'too_many_attempts';
    }
    return 'invalid_code';
  }
}
