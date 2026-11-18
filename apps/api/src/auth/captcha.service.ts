import { HttpStatus, Injectable } from '@nestjs/common';
import { type Challenge, createChallenge, type Solution, verifySolution } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/sha';
import { ApiError } from '../common/api-error.js';
import { ApiConfig } from '../config/api-config.js';
import { RedisService } from '../redis/redis.service.js';
import type { AttemptState } from './rate-limit.service.js';

const ALGORITHM = 'SHA-256';

/**
 * Self-hosted ALTCHA proof-of-work CAPTCHA: no third party, no cookie. A challenge is signed with
 * a local HMAC key; each solved challenge can be used once.
 */
@Injectable()
export class CaptchaService {
  constructor(
    private readonly config: ApiConfig,
    private readonly redis: RedisService,
  ) {}

  createChallenge(): Promise<Challenge> {
    const env = this.config.env;
    return createChallenge({
      algorithm: ALGORITHM,
      cost: 1,
      deriveKey,
      keyPrefix: env.ALTCHA_KEY_PREFIX,
      hmacSignatureSecret: env.ALTCHA_HMAC_KEY,
      expiresAt: new Date(Date.now() + env.ALTCHA_TTL_SECONDS * 1000),
    });
  }

  /** True when `payload` is a valid, unexpired and never used solution. */
  async verify(payload: string): Promise<boolean> {
    let parsed: { challenge?: Challenge; solution?: Solution };
    try {
      parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as typeof parsed;
    } catch {
      return false;
    }
    const { challenge, solution } = parsed;
    if (!challenge?.parameters || !challenge.signature || !solution) return false;
    if (challenge.parameters.algorithm !== ALGORITHM) return false;
    // The prefix is covered by the signature, but refuse a weaker one signed under an old setting.
    if (challenge.parameters.keyPrefix !== this.config.env.ALTCHA_KEY_PREFIX) return false;
    let result;
    try {
      result = await verifySolution({
        challenge,
        solution,
        deriveKey,
        hmacSignatureSecret: this.config.env.ALTCHA_HMAC_KEY,
      });
    } catch {
      return false;
    }
    if (!result.verified) return false;
    const used = await this.redis.client.set(
      `captcha:used:${challenge.signature}`,
      '1',
      'EX',
      this.config.env.ALTCHA_TTL_SECONDS + 60,
      'NX',
    );
    return used === 'OK';
  }

  /** Enforces the CAPTCHA when the failure counters require it. */
  async enforce(state: AttemptState, payload: string | undefined): Promise<void> {
    if (!state.captchaRequired) return;
    if (!payload) throw new ApiError(HttpStatus.PRECONDITION_REQUIRED, 'captcha_required');
    if (!(await this.verify(payload))) {
      throw new ApiError(HttpStatus.PRECONDITION_REQUIRED, 'captcha_invalid');
    }
  }
}
