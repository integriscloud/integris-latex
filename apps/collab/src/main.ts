import './load-env.js';
import { collabEnvSchema, parseEnv, PORTS } from '@integris/shared';
import { pino } from 'pino';
import { createCollabServer } from './server.js';

const env = parseEnv(collabEnvSchema, process.env);
const logger = pino({ name: 'collab', level: env.NODE_ENV === 'production' ? 'info' : 'debug' });
const server = createCollabServer({ port: PORTS.collab, logger });

await server.listen();
logger.info({ address: server.address }, 'collab server listening');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'collab server stopping');
    void server.destroy().then(() => process.exit(0));
  });
}
