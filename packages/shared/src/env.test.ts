import { describe, expect, it } from 'vitest';
import { apiEnvSchema, parseEnv, seedEnvSchema, workerEnvSchema } from './env.js';

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

describe('apiEnvSchema', () => {
  const base = {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
    REDIS_URL: 'redis://127.0.0.1:6379',
    AUTH_SECRET: 'a'.repeat(32),
    ALTCHA_HMAC_KEY: 'b'.repeat(32),
  };

  it('applies the V1 anti-abuse defaults', () => {
    const env = parseEnv(apiEnvSchema, base);
    expect(env.OTP_LENGTH).toBe(6);
    expect(env.SEND_LIMIT_PER_ID_15MIN).toBe(3);
    expect(env.AUTH_CAPTCHA_AFTER_FAILURES).toBe(3);
    expect(env.AUTH_ALLOWED_DIAL_CODES[0]).toBe('226');
  });

  it('parses list and number overrides', () => {
    const env = parseEnv(apiEnvSchema, {
      ...base,
      AUTH_ALLOWED_DIAL_CODES: '225, 226',
      OTP_TTL_SECONDS: '300',
    });
    expect(env.AUTH_ALLOWED_DIAL_CODES).toEqual(['225', '226']);
    expect(env.OTP_TTL_SECONDS).toBe(300);
  });

  it('requires NODE_ENV', () => {
    expect(() => parseEnv(apiEnvSchema, { ...base, NODE_ENV: undefined })).toThrow(/NODE_ENV/);
  });

  it('refuses development fakes and placeholders in production', () => {
    let message = '';
    try {
      parseEnv(apiEnvSchema, {
        ...base,
        NODE_ENV: 'production',
        AUTH_SECRET: 'change-me-dev-auth-secret-at-least-32-characters',
      });
    } catch (error) {
      message = String(error);
    }
    for (const name of ['SMS_PROVIDER', 'WEB_ORIGINS', 'PUBLIC_WEB_URL', 'AUTH_SECRET']) {
      expect(message).toContain(name);
    }
  });
});
