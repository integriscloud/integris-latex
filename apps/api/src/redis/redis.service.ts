import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { ApiConfig } from '../config/api-config.js';

/** Single Redis connection for sessions, codes and rate limits. */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(config: ApiConfig) {
    this.client = new Redis(config.env.REDIS_URL, { lazyConnect: false });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}
