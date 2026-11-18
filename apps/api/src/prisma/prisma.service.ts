import { apiEnvSchema, parseEnv } from '@integris/shared';
import { createPrismaClient, type PrismaClient } from '@integris/db';
import { Injectable, OnModuleDestroy } from '@nestjs/common';

/** Single Prisma client for the API process, closed on shutdown. */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly client: PrismaClient = createPrismaClient(
    parseEnv(apiEnvSchema, process.env).DATABASE_URL,
  );

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
