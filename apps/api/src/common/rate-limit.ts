import { HttpStatus } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ApiError } from './api-error.js';

/**
 * Counts one action in a fixed window and refuses it above `limit` (429 `rate_limited`, with the
 * seconds to wait). The counter and its expiry are set in one step.
 */
export async function consumeLimit(
  redis: Redis,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const replies = await redis.multi().incr(key).expire(key, windowSeconds, 'NX').exec();
  if (Number(replies?.[0]?.[1] ?? 0) > limit) {
    const ttl = await redis.ttl(key);
    throw new ApiError(HttpStatus.TOO_MANY_REQUESTS, 'rate_limited', Math.max(ttl, 1));
  }
}
