import { type ApiEnv, apiEnvSchema, parseEnv } from '@integris/shared';
import { Global, Injectable, Module } from '@nestjs/common';

/** Validated API environment, parsed once. Tests provide their own values. */
@Injectable()
export class ApiConfig {
  readonly env: ApiEnv = parseEnv(apiEnvSchema, process.env);
}

@Global()
@Module({ providers: [ApiConfig], exports: [ApiConfig] })
export class ConfigModule {}
