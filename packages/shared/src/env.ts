import { z } from 'zod';
import { DEFAULT_LIGDICASH_MIN_AMOUNT } from './billing.js';
import { PORTS } from './ports.js';

const nodeEnv = z.enum(['development', 'test', 'production']).default('development');

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

/** Optional text: an empty value (`KEY=` in .env) counts as missing. */
const optionalText = () =>
  z.preprocess((value) => (value === '' ? undefined : value), z.string().trim().min(1).optional());

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
    // Project downloads (ZIP) per account and per hour; one download at a time per project.
    ZIP_EXPORTS_PER_HOUR: positiveInt(20),
    // Files in one project (uploads and new files; an import is limited by ZIP_MAX_FILES).
    PROJECT_MAX_FILES: positiveInt(2000),
    // How often projects deleted more than 30 days ago are erased.
    TRASH_PURGE_INTERVAL_MINUTES: positiveInt(60),
    // Public base URL of the files domain serving PDFs by signed links (docs/spec.md: a sibling
    // of the app domain, never the app origin): latex-files.integriscloud.com in production,
    // test-latex-files.integriscloud.com on latex-dev, proxied by Nginx to PORTS.files.
    FILES_PUBLIC_URL: z.url().default(`http://127.0.0.1:${PORTS.files}`),
    // Shared with apps/collab: authenticates its calls to the internal API (port PORTS.internal).
    COLLAB_INTERNAL_SECRET: z.string().min(32),
    // How often projects with changes are checked for their automatic version (10 min after).
    HISTORY_SCAN_SECONDS: positiveInt(30),
    // Named versions and restorations per user per hour (each one copies files to the history).
    HISTORY_ACTIONS_PER_HOUR: positiveInt(30),
    // Submission sendings compiled per account (project owner, who is charged) and per hour,
    // across all projects (step 9). They never use the hourly compile quota of the plan.
    SUBMISSION_COMPILES_PER_HOUR: positiveInt(10),
    // Sharing (step 8). Limits rest on the account and on the token first; the per-address
    // limits are only a high backstop, since many mobile users share one address (CGNAT).
    SHARE_INVITATIONS_PER_DAY: positiveInt(50), // per owner account, every project together
    INVITATION_ACTIONS_PER_HOUR: positiveInt(30), // accept or decline, per signed-in account
    INVITATION_VIEWS_PER_HOUR_PER_TOKEN: positiveInt(60),
    INVITATION_VIEWS_PER_HOUR_PER_IP: positiveInt(2000),
    PUBLIC_LINK_READS_PER_HOUR_PER_TOKEN: positiveInt(3000), // openings and source files
    PUBLIC_LINK_READS_PER_HOUR_PER_IP: positiveInt(6000),
    // Payments (step 11): LigdiCash "payin avec redirection". `simulated` replaces LigdiCash by a
    // local payment page and callback (development only, refused in production).
    PAYMENT_PROVIDER: z.enum(['ligdicash', 'simulated']).default('ligdicash'),
    LIGDICASH_API_KEY: z.string().min(1),
    LIGDICASH_AUTH_TOKEN: z.string().min(1),
    // Base of the LigdiCash API only (https://app.ligdicash.com, no sandbox): the paths
    // (/pay/v01/...) are in the code.
    LIGDICASH_API_URL: z
      .url()
      .refine((url) => ['', '/'].includes(new URL(url).pathname), 'Base URL without path'),
    // Smallest amount of one LigdiCash transaction (FCFA). Below it, the minimum is paid and the
    // difference is added to the payer's credit balance.
    LIGDICASH_MIN_AMOUNT: positiveInt(DEFAULT_LIGDICASH_MIN_AMOUNT),
    // A payment still pending after this many hours is closed (its reserved credit given back);
    // paid later, it is credited to the payer.
    PAYMENT_PENDING_HOURS: positiveInt(24),
    // Technical ceiling of the seats of one self-serve order (BUSINESS has no maximum in the grid):
    // keeps amounts within the database integers and one payment from creating huge seat lists.
    BILLING_MAX_SEATS: positiveInt(5000),
    // Address shown to ask for a refund (credited duplicates) and on receipts.
    BILLING_SUPPORT_EMAIL: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.email().optional(),
    ),
    // Legal mentions of Integris Cloud on receipts: "à compléter" on the receipts while missing
    // in development; the API refuses to start in production without them (docs/spec.md,
    // "Points ouverts").
    BILLING_COMPANY_NAME: optionalText(),
    BILLING_RCCM: optionalText(),
    BILLING_IFU: optionalText(),
    BILLING_ADDRESS: optionalText(),
    // VAT rate (%) shown on receipts. Plan prices are TTC: the receipt splits the amount paid
    // into HT and VAT with this rate (0 until the accountant of Integris decides).
    VAT_RATE_PERCENT: z.coerce.number().min(0).max(100).default(0),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    // Development fakes and placeholders are refused on a production server.
    if (env.SMS_PROVIDER === 'log' || env.MAIL_PROVIDER === 'log') {
      ctx.addIssue({ code: 'custom', path: ['SMS_PROVIDER'], message: 'Development provider' });
    }
    if (env.PAYMENT_PROVIDER === 'simulated') {
      ctx.addIssue({ code: 'custom', path: ['PAYMENT_PROVIDER'], message: 'Development provider' });
    }
    if (!env.LIGDICASH_API_URL.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['LIGDICASH_API_URL'], message: 'HTTPS required' });
    }
    for (const name of [
      'BILLING_SUPPORT_EMAIL',
      'BILLING_COMPANY_NAME',
      'BILLING_RCCM',
      'BILLING_IFU',
      'BILLING_ADDRESS',
    ] as const) {
      if (!env[name])
        ctx.addIssue({ code: 'custom', path: [name], message: 'Required in production' });
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
    // Redis is on the data server: TLS only (CLAUDE.md, "Security rules").
    if (!env.REDIS_URL.startsWith('rediss://')) {
      ctx.addIssue({ code: 'custom', path: ['REDIS_URL'], message: 'TLS required' });
    }
    if (!env.FILES_PUBLIC_URL.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['FILES_PUBLIC_URL'], message: 'HTTPS required' });
    }
    // User content never shares the origin (or a subdomain) of the app.
    const filesHost = new URL(env.FILES_PUBLIC_URL).hostname;
    const appHosts = [env.PUBLIC_WEB_URL, ...env.WEB_ORIGINS].map((url) => new URL(url).hostname);
    if (appHosts.some((host) => filesHost === host || filesHost.endsWith(`.${host}`))) {
      ctx.addIssue({ code: 'custom', path: ['FILES_PUBLIC_URL'], message: 'Same site as the app' });
    }
    for (const name of [
      'AUTH_SECRET',
      'ALTCHA_HMAC_KEY',
      'MINIO_API_SECRET_KEY',
      'COLLAB_INTERNAL_SECRET',
      'LIGDICASH_API_KEY',
      'LIGDICASH_AUTH_TOKEN',
    ] as const) {
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

/**
 * Environment read by apps/collab. The collaboration server holds no business rule and no
 * storage key: it checks every connection and stores documents through the internal API.
 */
export const collabEnvSchema = z
  .object({
    NODE_ENV: nodeEnv,
    // Events from the API (files replaced or deleted, rights changed), read as the Redis ACL
    // user `collab`: subscription to the channel `collab:events` only (docs/spec.md, "Réseau
    // et pare-feu"). Not REDIS_URL, which is the API's full access.
    COLLAB_REDIS_URL: z.url(),
    // Browser origins allowed to open a WebSocket (cross-site WebSocket hijacking defence).
    WEB_ORIGINS: csv('http://127.0.0.1:3000,http://localhost:3000').pipe(z.array(z.url()).min(1)),
    COLLAB_INTERNAL_SECRET: z.string().min(32),
    // Internal API of apps/api (loopback).
    API_INTERNAL_COLLAB_URL: z.url().default(`http://127.0.0.1:${PORTS.internal}`),
    // Every connection is checked again this often (session ended, right lost).
    COLLAB_RECHECK_SECONDS: positiveInt(60),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    if (env.COLLAB_INTERNAL_SECRET.includes('change-me')) {
      ctx.addIssue({ code: 'custom', path: ['COLLAB_INTERNAL_SECRET'], message: 'Placeholder' });
    }
    if (!env.COLLAB_REDIS_URL.startsWith('rediss://')) {
      ctx.addIssue({ code: 'custom', path: ['COLLAB_REDIS_URL'], message: 'TLS required' });
    }
    if (new URL(env.COLLAB_REDIS_URL).username !== 'collab') {
      ctx.addIssue({ code: 'custom', path: ['COLLAB_REDIS_URL'], message: 'ACL user collab' });
    }
    for (const origin of env.WEB_ORIGINS) {
      if (!origin.startsWith('https://')) {
        ctx.addIssue({ code: 'custom', path: ['WEB_ORIGINS'], message: 'HTTPS required' });
      }
    }
  });
export type CollabEnv = z.infer<typeof collabEnvSchema>;

/**
 * Environment read by apps/worker. Workers only reach Redis and MinIO: no app secrets here. The
 * MinIO key of the worker only reads and writes the compilation buckets; project files come as
 * presigned URLs in the jobs. Container limits are the same for every plan (docs/spec.md,
 * "Compilation"); only the duration comes from the plan, in the job.
 */
export const workerEnvSchema = z
  .object({
    NODE_ENV: nodeEnv,
    REDIS_URL: z.url(),
    MINIO_ENDPOINT: minioEndpoint,
    MINIO_WORKER_ACCESS_KEY: z.string().min(3),
    MINIO_WORKER_SECRET_KEY: z.string().min(8),
    // Name reported on each compilation (defaults to the host name).
    WORKER_NAME: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,100}$/)
      .optional(),
    // Jobs compiled at the same time by this worker.
    COMPILE_CONCURRENCY: positiveInt(2),
    SANDBOX_IMAGE: z.string().min(1).default('integris/texlive:2026'),
    // gVisor. `runc` is only accepted outside production (CI machines without gVisor).
    SANDBOX_RUNTIME: z.enum(['runsc', 'runc']).default('runsc'),
    COMPILE_CPUS: z.coerce.number().positive().max(64).default(2),
    COMPILE_MEMORY_MB: positiveInt(2048),
    COMPILE_PIDS: positiveInt(128),
    // Working directory (sources, cache and results) and /tmp, both in memory.
    COMPILE_WORKDIR_MB: positiveInt(1024),
    COMPILE_TMP_MB: positiveInt(256),
    COMPILE_MAX_PDF_MB: positiveInt(200),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      if (env.SANDBOX_RUNTIME !== 'runsc') {
        ctx.addIssue({ code: 'custom', path: ['SANDBOX_RUNTIME'], message: 'gVisor required' });
      }
      // Workers reach Redis over a public IP: TLS only (CLAUDE.md, "Security rules").
      if (!env.REDIS_URL.startsWith('rediss://')) {
        ctx.addIssue({ code: 'custom', path: ['REDIS_URL'], message: 'TLS required' });
      }
      if (env.MINIO_WORKER_SECRET_KEY.includes('change-me')) {
        ctx.addIssue({ code: 'custom', path: ['MINIO_WORKER_SECRET_KEY'], message: 'Placeholder' });
      }
    }
    if (env.COMPILE_WORKDIR_MB + env.COMPILE_TMP_MB >= env.COMPILE_MEMORY_MB) {
      // Both are tmpfs, counted in the memory of the container.
      ctx.addIssue({ code: 'custom', path: ['COMPILE_MEMORY_MB'], message: 'Below tmpfs sizes' });
    }
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
