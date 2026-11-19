import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

// Workers must not hold application secrets (database, MinIO root, other Redis users): in local
// development, copy only the variables the worker needs from the root .env, without overriding
// what is already set. Servers inject the environment themselves, so production skips the file.
// Child processes (docker, compilation containers) are spawned with PATH only (sandbox.ts).
const WORKER_VARIABLES = [
  'NODE_ENV',
  'REDIS_URL',
  'MINIO_ENDPOINT',
  'MINIO_WORKER_ACCESS_KEY',
  'MINIO_WORKER_SECRET_KEY',
  'WORKER_NAME',
  'COMPILE_CONCURRENCY',
  'SANDBOX_IMAGE',
  'SANDBOX_RUNTIME',
  'COMPILE_CPUS',
  'COMPILE_MEMORY_MB',
  'COMPILE_PIDS',
  'COMPILE_WORKDIR_MB',
  'COMPILE_TMP_MB',
  'COMPILE_MAX_PDF_MB',
] as const;

const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url));
if (process.env.NODE_ENV !== 'production' && existsSync(rootEnv)) {
  const fileEnv = parseEnv(readFileSync(rootEnv, 'utf8'));
  for (const name of WORKER_VARIABLES) {
    const value = fileEnv[name];
    if (value !== undefined && process.env[name] === undefined) process.env[name] = value;
  }
}
