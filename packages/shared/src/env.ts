import { z } from 'zod';

const nodeEnv = z.enum(['development', 'test', 'production']).default('development');

/** Environment read by apps/api. */
export const apiEnvSchema = z.object({
  NODE_ENV: nodeEnv,
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
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
  MINIO_ENDPOINT: z
    .url()
    .refine(
      (url) => url.startsWith('https://') || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url),
      'MinIO must use TLS outside localhost',
    )
    .default('http://127.0.0.1:9000'),
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
