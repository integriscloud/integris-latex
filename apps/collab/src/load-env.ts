import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Local development reads the monorepo root .env. Servers inject real environment variables.
const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
