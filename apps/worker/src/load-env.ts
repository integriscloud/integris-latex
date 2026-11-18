import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

// Workers must not hold application secrets (database, MinIO root, other Redis users): in local
// development, copy only the variables the worker needs from the root .env, without overriding
// what is already set. Servers inject the environment themselves, so production skips the file.
// Child processes (compilation containers, step 6) must be spawned with an explicit minimal env.
const WORKER_VARIABLES = ['NODE_ENV', 'REDIS_URL'] as const;

const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url));
if (process.env.NODE_ENV !== 'production' && existsSync(rootEnv)) {
  const fileEnv = parseEnv(readFileSync(rootEnv, 'utf8'));
  for (const name of WORKER_VARIABLES) {
    const value = fileEnv[name];
    if (value !== undefined && process.env[name] === undefined) process.env[name] = value;
  }
}
