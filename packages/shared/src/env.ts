import { z } from 'zod';

const nodeEnv = z.enum(['development', 'test', 'production']).default('development');

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

/** Comma-separated list, e.g. "226,225". Empty items are dropped. */
const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    );

const MIB = 1024 * 1024;

/** MinIO endpoint: TLS required outside the local machine. */
const minioEndpoint = z
  .url()
  .refine(
    (url) => url.startsWith('https://') || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url),
    'MinIO must use TLS outside localhost',
  )
  .default('http://127.0.0.1:9000');

/**
 * Environment read by apps/api. Anti-abuse limits and session lifetimes are configuration, not
 * code: the defaults below are the values decided for V1 and can be overridden per server.
 */
export const apiEnvSchema = z
  .object({
    // Required: a forgotten NODE_ENV must never enable development behaviour on a server.
    NODE_ENV: z.enum(['development', 'test', 'production']),
    DATABASE_URL: z.url(),
    REDIS_URL: z.url(),
    // Browser origins allowed to call state-changing endpoints (CSRF defence).
    WEB_ORIGINS: csv('http://127.0.0.1:3000,http://localhost:3000').pipe(z.array(z.url()).min(1)),
    // Base URL used in links sent by e-mail (verification, password reset).
    PUBLIC_WEB_URL: z.url().default('http://127.0.0.1:3000'),
    // Secret for HMAC of OTP codes, tokens and rate-limit keys.
    AUTH_SECRET: z.string().min(32),
    // `log` writes messages to the API logs instead of sending them (development only).
    SMS_PROVIDER: z.enum(['log']).default('log'),
    MAIL_PROVIDER: z.enum(['log']).default('log'),
    // Self-hosted ALTCHA proof-of-work CAPTCHA.
    ALTCHA_HMAC_KEY: z.string().min(32),
    ALTCHA_KEY_PREFIX: z
      .string()
      .regex(/^[0-9a-f]{1,8}$/)
      .default('0000'),
    ALTCHA_TTL_SECONDS: positiveInt(300),
    // Proof-of-work difficulty: hex prefix the hash must start with (each 0 multiplies the work
    // by 16) and number of hash rounds per try.
    ALTCHA_COST: positiveInt(1),
    // Allowed country calling codes for phone numbers (first one is the default in the UI).
    AUTH_ALLOWED_DIAL_CODES: csv('226,225,223,227,228,229,221,33').pipe(
      z.array(z.string().regex(/^\d{1,4}$/)).min(1),
    ),
    OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
    OTP_TTL_SECONDS: positiveInt(600),
    OTP_MAX_ATTEMPTS: positiveInt(5),
    OTP_RESEND_SECONDS: positiveInt(60),
    // Codes (SMS) and e-mails sent: per phone or e-mail address, and per IP.
    SEND_LIMIT_PER_ID_15MIN: positiveInt(3),
    SEND_LIMIT_PER_ID_DAY: positiveInt(10),
    SEND_LIMIT_PER_IP_HOUR: positiveInt(20),
    SEND_LIMIT_PER_IP_DAY: positiveInt(100),
    // Failed codes or passwords: CAPTCHA after N failures, lock of the identifier after M.
    AUTH_FAILURE_WINDOW_SECONDS: positiveInt(3600),
    AUTH_CAPTCHA_AFTER_FAILURES: positiveInt(3),
    AUTH_LOCK_AFTER_FAILURES: positiveInt(10),
    AUTH_LOCK_SECONDS: positiveInt(900),
    // SMS sent per day by the whole platform (toll-fraud guard): warning in the logs at 80 %,
    // codes refused at 100 %.
    SMS_DAILY_LIMIT: positiveInt(1000),
    // Validity of a confirmation by SMS code before changing the e-mail or the password.
    AUTH_REAUTH_SECONDS: positiveInt(600),
    SESSION_IDLE_DAYS: positiveInt(30),
    SESSION_MAX_DAYS: positiveInt(90),
    PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).max(64).default(10),
    // MinIO access key of the API (its own key, limited to the projects and templates buckets).
    MINIO_ENDPOINT: minioEndpoint,
    MINIO_API_ACCESS_KEY: z.string().min(3),
    MINIO_API_SECRET_KEY: z.string().min(8),
    // ZIP import (anti ZIP bomb). Each extracted file is also limited to 10 MB (docs/spec.md).
    ZIP_MAX_ARCHIVE_BYTES: positiveInt(50 * MIB),
    ZIP_MAX_TOTAL_BYTES: positiveInt(200 * MIB),
    ZIP_MAX_FILES: positiveInt(2000),
    // Maximum ratio extracted size / compressed size of one file, checked once a file has
    // produced ZIP_RATIO_MIN_BYTES (small text files legitimately compress very well).
    ZIP_MAX_RATIO: positiveInt(100),
    ZIP_RATIO_MIN_BYTES: positiveInt(MIB),
    // Imports decompressing at the same time in one API process, and imports per user per hour.
    ZIP_MAX_CONCURRENT_IMPORTS: positiveInt(2),
    ZIP_IMPORTS_PER_HOUR: positiveInt(20),
    // Files in one project (uploads and new files; an import is limited by ZIP_MAX_FILES).
    PROJECT_MAX_FILES: positiveInt(2000),
    // How often projects deleted more than 30 days ago are erased.
    TRASH_PURGE_INTERVAL_MINUTES: positiveInt(60),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    // Development fakes and placeholders are refused on a production server.
    if (env.SMS_PROVIDER === 'log' || env.MAIL_PROVIDER === 'log') {
      ctx.addIssue({ code: 'custom', path: ['SMS_PROVIDER'], message: 'Development provider' });
    }
    const urls: [string, string][] = [
      ['PUBLIC_WEB_URL', env.PUBLIC_WEB_URL],
      ...env.WEB_ORIGINS.map((origin): [string, string] => ['WEB_ORIGINS', origin]),
    ];
    for (const [name, url] of urls) {
      if (!url.startsWith('https://')) {
        ctx.addIssue({ code: 'custom', path: [name], message: 'HTTPS required' });
      }
    }
    for (const name of ['AUTH_SECRET', 'ALTCHA_HMAC_KEY', 'MINIO_API_SECRET_KEY'] as const) {
      if (env[name].includes('change-me')) {
        ctx.addIssue({ code: 'custom', path: [name], message: 'Placeholder secret' });
      }
    }
  });
export type ApiEnv = z.infer<typeof apiEnvSchema>;

/** Environment read by apps/web (server side only). */
export const webEnvSchema = z.object({
  NODE_ENV: nodeEnv,
  // Where the Next.js server reaches the API. Defaults to the local API port.
  API_INTERNAL_URL: z.url().optional(),
});
export type WebEnv = z.infer<typeof webEnvSchema>;

/** Environment read by apps/collab. */
export const collabEnvSchema = z.object({
  NODE_ENV: nodeEnv,
});
export type CollabEnv = z.infer<typeof collabEnvSchema>;

/** Environment read by apps/worker. Workers only reach Redis and MinIO: no app secrets here. */
export const workerEnvSchema = z.object({
  NODE_ENV: nodeEnv,
  REDIS_URL: z.url(),
});
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/**
 * Environment read by the database seed (packages/db). On latex-dev it uploads templates with the
 * MinIO root credentials; services get their own access keys in later steps.
 */
export const seedEnvSchema = z.object({
  DATABASE_URL: z.url(),
  MINIO_ENDPOINT: minioEndpoint,
  MINIO_ROOT_USER: z.string().min(1),
  MINIO_ROOT_PASSWORD: z.string().min(1),
});
export type SeedEnv = z.infer<typeof seedEnvSchema>;

/** Parse an environment, failing fast with the list of invalid variables (values are never printed). */
export function parseEnv<T extends z.ZodType>(schema: T, source: NodeJS.ProcessEnv): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid environment variables: ${fields}`);
  }
  return result.data;
}
