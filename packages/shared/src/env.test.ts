import { describe, expect, it } from 'vitest';
import { parseEnv, workerEnvSchema } from './env.js';

describe('parseEnv', () => {
  it('returns typed values when the environment is valid', () => {
    const env = parseEnv(workerEnvSchema, { REDIS_URL: 'redis://localhost:6379' });
    expect(env).toEqual({ NODE_ENV: 'development', REDIS_URL: 'redis://localhost:6379' });
  });

  it('names invalid variables without leaking their values', () => {
    expect(() => parseEnv(workerEnvSchema, { REDIS_URL: 'not-a-url-secret' })).toThrow(/REDIS_URL/);
    expect(() => parseEnv(workerEnvSchema, { REDIS_URL: 'not-a-url-secret' })).not.toThrow(
      /secret/,
    );
  });
});
