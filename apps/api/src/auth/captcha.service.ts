import type { CaptchaAction } from '@integris/shared';
import { HttpStatus, Injectable } from '@nestjs/common';
import { type Challenge, createChallenge, type Solution, verifySolution } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/sha';
import { ApiError } from '../common/api-error.js';
import { ApiConfig } from '../config/api-config.js';
import { RedisService } from '../redis/redis.service.js';
import { keyedHash } from './keys.js';
import type { AttemptState } from './rate-limit.service.js';

const ALGORITHM = 'SHA-256';

/**
 * Self-hosted ALTCHA proof-of-work CAPTCHA: no third party, no cookie. A challenge is signed with
 * a local HMAC key for one action and one target (keyed hash of the phone, e-mail or user), so a
 * solution cannot be prepared in advance for other numbers; each solution can be used once.
 */
@Injectable()
export class CaptchaService {
  constructor(
    private readonly config: ApiConfig,
    private readonly redis: RedisService,
  ) {}

  private target(identifier: string): string {
    return keyedHash(this.config.env.AUTH_SECRET, `captcha:${identifier}`);
  }

  createChallenge(action: CaptchaAction, identifier: string): Promise<Challenge> {
    const env = this.config.env;
    return createChallenge({
      algorithm: ALGORITHM,
      cost: env.ALTCHA_COST,
      deriveKey,
      // Covered by the signature together with the other parameters.
      data: { action, target: this.target(identifier) },
      keyPrefix: env.ALTCHA_KEY_PREFIX,
      hmacSignatureSecret: env.ALTCHA_HMAC_KEY,
      expiresAt: new Date(Date.now() + env.ALTCHA_TTL_SECONDS * 1000),
    });
  }

  /** True when `payload` is a valid, unexpired, never used solution for this action and target. */
  async verify(payload: string, action: CaptchaAction, identifier: string): Promise<boolean> {
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
    if (challenge.parameters.cost !== this.config.env.ALTCHA_COST) return false;
    const data = challenge.parameters.data;
    if (data?.action !== action || data.target !== this.target(identifier)) return false;
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
  async enforce(
    state: AttemptState,
    payload: string | undefined,
    action: CaptchaAction,
    identifier: string,
  ): Promise<void> {
    if (!state.captchaRequired) return;
    if (!payload) throw new ApiError(HttpStatus.PRECONDITION_REQUIRED, 'captcha_required');
    if (!(await this.verify(payload, action, identifier))) {
      throw new ApiError(HttpStatus.PRECONDITION_REQUIRED, 'captcha_invalid');
    }
  }
}
