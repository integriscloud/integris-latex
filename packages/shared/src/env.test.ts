import { describe, expect, it } from 'vitest';
import { apiEnvSchema, parseEnv, seedEnvSchema, workerEnvSchema } from './env.js';

describe('parseEnv', () => {
  const worker = {
    REDIS_URL: 'redis://localhost:6379',
    MINIO_WORKER_ACCESS_KEY: 'integris-worker',
    MINIO_WORKER_SECRET_KEY: 'worker-secret',
  };

  it('returns typed values when the environment is valid', () => {
    const env = parseEnv(workerEnvSchema, worker);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      REDIS_URL: 'redis://localhost:6379',
      SANDBOX_RUNTIME: 'runsc',
      COMPILE_MEMORY_MB: 2048,
      COMPILE_WORKDIR_MB: 1024,
    });
  });

  it('names invalid variables without leaking their values', () => {
    const invalid = { ...worker, REDIS_URL: 'not-a-url-secret' };
    expect(() => parseEnv(workerEnvSchema, invalid)).toThrow(/REDIS_URL/);
    expect(() => parseEnv(workerEnvSchema, invalid)).not.toThrow(/not-a-url/);
  });

  it('requires gVisor in production and memory above the in-memory directories', () => {
    expect(() =>
      parseEnv(workerEnvSchema, { ...worker, NODE_ENV: 'production', SANDBOX_RUNTIME: 'runc' }),
    ).toThrow(/SANDBOX_RUNTIME/);
    expect(() => parseEnv(workerEnvSchema, { ...worker, COMPILE_MEMORY_MB: '1024' })).toThrow(
      /COMPILE_MEMORY_MB/,
    );
  });

  it('requires TLS to Redis and a real MinIO secret in production', () => {
    let message = '';
    try {
      parseEnv(workerEnvSchema, {
        ...worker,
        NODE_ENV: 'production',
        MINIO_WORKER_SECRET_KEY: 'change-me-dev-minio-worker-secret',
      });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('REDIS_URL');
    expect(message).toContain('MINIO_WORKER_SECRET_KEY');
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
    MINIO_API_ACCESS_KEY: 'api',
    MINIO_API_SECRET_KEY: 'c'.repeat(32),
  };

  it('applies the V1 anti-abuse defaults', () => {
    const env = parseEnv(apiEnvSchema, base);
    expect(env.OTP_LENGTH).toBe(6);
    expect(env.SEND_LIMIT_PER_ID_15MIN).toBe(3);
    expect(env.AUTH_CAPTCHA_AFTER_FAILURES).toBe(3);
    expect(env.AUTH_ALLOWED_DIAL_CODES[0]).toBe('226');
  });

  it('applies the ZIP import limits decided for V1', () => {
    const env = parseEnv(apiEnvSchema, base);
    expect(env.ZIP_MAX_ARCHIVE_BYTES).toBe(50 * 1024 * 1024);
    expect(env.ZIP_MAX_TOTAL_BYTES).toBe(200 * 1024 * 1024);
    expect(env.ZIP_MAX_FILES).toBe(2000);
    expect(env.ZIP_MAX_RATIO).toBe(100);
  });

  it('requires the MinIO access key of the API', () => {
    expect(() => parseEnv(apiEnvSchema, { ...base, MINIO_API_SECRET_KEY: undefined })).toThrow(
      /MINIO_API_SECRET_KEY/,
    );
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
        MINIO_API_SECRET_KEY: 'change-me-dev-minio-api',
      });
    } catch (error) {
      message = String(error);
    }
    for (const name of [
      'SMS_PROVIDER',
      'WEB_ORIGINS',
      'PUBLIC_WEB_URL',
      'AUTH_SECRET',
      'MINIO_API_SECRET_KEY',
      'FILES_PUBLIC_URL',
    ]) {
      expect(message).toContain(name);
    }
  });

  it('serves files from a sibling domain, never from the app or one of its subdomains', () => {
    const production = {
      ...base,
      NODE_ENV: 'production',
      SMS_PROVIDER: undefined,
      PUBLIC_WEB_URL: 'https://latex.integriscloud.com',
      WEB_ORIGINS: 'https://latex.integriscloud.com',
    };
    const files = (url: string) => () =>
      parseEnv(apiEnvSchema, { ...production, FILES_PUBLIC_URL: url });
    // The production check also refuses the log SMS provider: only FILES_PUBLIC_URL matters here.
    expect(files('https://latex.integriscloud.com')).toThrow(/FILES_PUBLIC_URL/);
    expect(files('https://files.latex.integriscloud.com')).toThrow(/FILES_PUBLIC_URL/);
    expect(files('https://latex-files.integriscloud.com')).not.toThrow(/FILES_PUBLIC_URL/);
  });
});
