import { z } from 'zod';

const nodeEnv = z.enum(['development', 'test', 'production']).default('development');

/** Environment read by apps/api. */
export const apiEnvSchema = z.object({
  NODE_ENV: nodeEnv,
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
});
export type ApiEnv = z.infer<typeof apiEnvSchema>;

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

/** Parse an environment, failing fast with the list of invalid variables (values are never printed). */
export function parseEnv<T extends z.ZodType>(schema: T, source: NodeJS.ProcessEnv): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid environment variables: ${fields}`);
  }
  return result.data;
}
