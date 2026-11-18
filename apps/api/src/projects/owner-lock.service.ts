import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ApiError } from '../common/api-error.js';
import { RedisService } from '../redis/redis.service.js';

// Releases or extends the lock only when it is still ours.
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`;
const EXTEND = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) end return 0`;

const LOCK_MS = 60_000;
const RENEW_MS = 20_000;
const WAIT_MS = 15_000;
const RETRY_MS = 100;

/**
 * Serializes the operations that add projects or bytes to one owner, so that two parallel
 * uploads or imports cannot both pass the quota check. The lock is extended while the task runs,
 * so a long import never loses it.
 */
@Injectable()
export class OwnerLockService {
  private readonly logger = new Logger(OwnerLockService.name);

  constructor(private readonly redis: RedisService) {}

  async run<T>(ownerId: string, task: () => Promise<T>): Promise<T> {
    const key = `lock:owner:${ownerId}`;
    const token = randomUUID();
    const deadline = Date.now() + WAIT_MS;
    while ((await this.redis.client.set(key, token, 'PX', LOCK_MS, 'NX')) !== 'OK') {
      if (Date.now() > deadline) throw new ApiError(HttpStatus.CONFLICT, 'busy');
      await sleep(RETRY_MS);
    }
    const renew = setInterval(() => {
      void this.redis.client
        .eval(EXTEND, 1, key, token, LOCK_MS)
        .then((extended) => {
          if (extended !== 1) this.logger.warn({ ownerId }, 'Owner lock lost during a task');
        })
        .catch((error: unknown) =>
          this.logger.warn({ err: error, ownerId }, 'Owner lock renewal failed'),
        );
    }, RENEW_MS);
    try {
      return await task();
    } finally {
      clearInterval(renew);
      await this.redis.client.eval(RELEASE, 1, key, token);
    }
  }
}

/** At most `size` tasks at a time in this process; the others wait a little, then get "busy". */
export class Slots {
  private running = 0;

  constructor(private readonly size: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + WAIT_MS;
    while (this.running >= this.size) {
      if (Date.now() > deadline) throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'busy');
      await sleep(RETRY_MS * 5);
    }
    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
    }
  }
}
