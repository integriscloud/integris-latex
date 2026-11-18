import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { ApiConfig } from '../config/api-config.js';
import { RedisService } from '../redis/redis.service.js';
import { ipBucket, keyedHash } from './keys.js';

// Fixed-window counter: increments and sets the expiry on the first hit, atomically.
const HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return { count, redis.call('TTL', KEYS[1]) }
`;

// Reserves an attempt: refuses while locked, counts it for the identifier and the IP, locks the
// identifier at the threshold, and reports whether the failures before it require a CAPTCHA.
const BEGIN_ATTEMPT_SCRIPT = `
local lock = redis.call('TTL', KEYS[1])
if lock > 0 then return { -1, lock } end
local id = redis.call('INCR', KEYS[2])
if id == 1 then redis.call('EXPIRE', KEYS[2], ARGV[1]) end
local ip = redis.call('INCR', KEYS[3])
if ip == 1 then redis.call('EXPIRE', KEYS[3], ARGV[1]) end
if id >= tonumber(ARGV[2]) then
  redis.call('SET', KEYS[1], '1', 'EX', ARGV[3])
  redis.call('DEL', KEYS[2])
end
local threshold = tonumber(ARGV[4])
if id - 1 >= threshold or ip - 1 >= threshold then return { 1, 0 } end
return { 0, 0 }
`;

// Gives back a reserved attempt; ARGV[1] = 1 clears the identifier counter (success).
const RELEASE_SCRIPT = `
if ARGV[1] == '1' then
  redis.call('DEL', KEYS[1])
elseif tonumber(redis.call('GET', KEYS[1]) or '0') > 0 then
  redis.call('DECR', KEYS[1])
end
if tonumber(redis.call('GET', KEYS[2]) or '0') > 0 then redis.call('DECR', KEYS[2]) end
return 1
`;

interface Limit {
  key: string;
  max: number;
  windowSeconds: number;
}

export interface AttemptState {
  captchaRequired: boolean;
}

/**
 * Anti-abuse counters in Redis: messages sent (SMS codes, e-mails) per identifier and per IP, and
 * failed attempts (codes, passwords) leading to a CAPTCHA then to a temporary lock.
 */
@Injectable()
export class RateLimitService {
  constructor(
    private readonly redis: RedisService,
    private readonly config: ApiConfig,
  ) {}

  private hash(value: string): string {
    return keyedHash(this.config.env.AUTH_SECRET, value);
  }

  private async hit(key: string, windowSeconds: number): Promise<[number, number]> {
    const [count, ttl] = (await this.redis.client.eval(HIT_SCRIPT, 1, key, windowSeconds)) as [
      number,
      number,
    ];
    return [count, Math.max(ttl, 0)];
  }

  /**
   * Counts one message sent to `identifier` (phone or e-mail) from `ip`. Throws `rate_limited`
   * with the longest wait when any limit is exceeded.
   */
  async consumeSend(identifier: string, ip: string): Promise<void> {
    const env = this.config.env;
    const id = this.hash(identifier);
    const from = this.hash(ipBucket(ip));
    const limits: Limit[] = [
      { key: `rl:send:id:15m:${id}`, max: env.SEND_LIMIT_PER_ID_15MIN, windowSeconds: 900 },
      { key: `rl:send:id:day:${id}`, max: env.SEND_LIMIT_PER_ID_DAY, windowSeconds: 86_400 },
      { key: `rl:send:ip:hour:${from}`, max: env.SEND_LIMIT_PER_IP_HOUR, windowSeconds: 3600 },
      { key: `rl:send:ip:day:${from}`, max: env.SEND_LIMIT_PER_IP_DAY, windowSeconds: 86_400 },
    ];
    let retryAfter = 0;
    for (const limit of limits) {
      const [count, ttl] = await this.hit(limit.key, limit.windowSeconds);
      if (count > limit.max) retryAfter = Math.max(retryAfter, ttl);
    }
    if (retryAfter > 0)
      throw new ApiError(HttpStatus.TOO_MANY_REQUESTS, 'rate_limited', retryAfter);
  }

  /**
   * Read-only check before sending a message: throws `locked` while the identifier is locked and
   * reports whether a CAPTCHA is required (failures of the identifier or of the IP).
   */
  async checkAttempt(identifier: string, ip: string): Promise<AttemptState> {
    const id = this.hash(identifier);
    const [lockTtl, idFailures, ipFailures] = await Promise.all([
      this.redis.client.ttl(`rl:lock:${id}`),
      this.redis.client.get(`rl:fail:id:${id}`),
      this.redis.client.get(`rl:fail:ip:${this.hash(ipBucket(ip))}`),
    ]);
    if (lockTtl > 0) throw new ApiError(HttpStatus.TOO_MANY_REQUESTS, 'locked', lockTtl);
    const threshold = this.config.env.AUTH_CAPTCHA_AFTER_FAILURES;
    return {
      captchaRequired: Number(idFailures ?? 0) >= threshold || Number(ipFailures ?? 0) >= threshold,
    };
  }

  /**
   * Reserves one attempt (code or password check) before it runs, atomically: the attempt counts
   * as a failure until `succeed` or `release` is called. Concurrent requests therefore cannot all
   * pass the CAPTCHA threshold or the lock. Throws `locked` while the identifier is locked.
   */
  async beginAttempt(identifier: string, ip: string): Promise<AttemptState> {
    const env = this.config.env;
    const id = this.hash(identifier);
    const [captcha, lockTtl] = (await this.redis.client.eval(
      BEGIN_ATTEMPT_SCRIPT,
      3,
      `rl:lock:${id}`,
      `rl:fail:id:${id}`,
      `rl:fail:ip:${this.hash(ipBucket(ip))}`,
      env.AUTH_FAILURE_WINDOW_SECONDS,
      env.AUTH_LOCK_AFTER_FAILURES,
      env.AUTH_LOCK_SECONDS,
      env.AUTH_CAPTCHA_AFTER_FAILURES,
    )) as [number, number];
    if (captcha < 0) throw new ApiError(HttpStatus.TOO_MANY_REQUESTS, 'locked', lockTtl);
    return { captchaRequired: captcha === 1 };
  }

  /** The reserved attempt succeeded: clears the identifier failures and gives back the IP one. */
  async succeed(identifier: string, ip: string): Promise<void> {
    await this.redis.client.eval(
      RELEASE_SCRIPT,
      2,
      `rl:fail:id:${this.hash(identifier)}`,
      `rl:fail:ip:${this.hash(ipBucket(ip))}`,
      1,
    );
  }

  /** The reserved attempt was not made (CAPTCHA missing or invalid): gives back both counts. */
  async release(identifier: string, ip: string): Promise<void> {
    await this.redis.client.eval(
      RELEASE_SCRIPT,
      2,
      `rl:fail:id:${this.hash(identifier)}`,
      `rl:fail:ip:${this.hash(ipBucket(ip))}`,
      0,
    );
  }
}
