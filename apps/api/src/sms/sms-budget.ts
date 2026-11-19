import { HttpStatus, type Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ApiError } from '../common/api-error.js';

/**
 * Platform-wide SMS budget per UTC day (guard against SMS toll fraud), shared by codes and
 * invitations: a warning in the logs at 80 %, an error and a clear refusal once it is used up.
 */
export async function consumeSmsBudget(redis: Redis, limit: number, logger: Logger) {
  const key = `rl:sms:day:${new Date().toISOString().slice(0, 10)}`;
  const [count] = (await redis
    .multi()
    .incr(key)
    .expire(key, 2 * 86_400)
    .exec()
    .then((replies) => replies?.map(([, value]) => value) ?? [0])) as [number];
  if (count === Math.ceil(limit * 0.8)) {
    logger.warn(`SMS daily budget at 80 % (${count}/${limit})`);
  }
  if (count > limit) {
    if (count === limit + 1) logger.error(`SMS daily budget used up (${limit}): SMS refused`);
    throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'sms_unavailable');
  }
}
