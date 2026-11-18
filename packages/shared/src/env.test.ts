import { describe, expect, it } from 'vitest';
import { parseEnv, seedEnvSchema, workerEnvSchema } from './env.js';

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

describe('seedEnvSchema', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
    MINIO_ROOT_USER: 'user',
    MINIO_ROOT_PASSWORD: 'password',
  };

  it('defaults to the local MinIO', () => {
    expect(parseEnv(seedEnvSchema, base).MINIO_ENDPOINT).toBe('http://127.0.0.1:9000');
  });

  it('refuses plain HTTP outside localhost', () => {
    expect(() =>
      parseEnv(seedEnvSchema, { ...base, MINIO_ENDPOINT: 'http://102.204.24.221:9000' }),
    ).toThrow(/MINIO_ENDPOINT/);
    expect(
      parseEnv(seedEnvSchema, { ...base, MINIO_ENDPOINT: 'https://minio.internal:9000' })
        .MINIO_ENDPOINT,
    ).toBe('https://minio.internal:9000');
  });
});
