import './load-env.js';
import {
  COLLAB_EVENTS_CHANNEL,
  collabEnvSchema,
  collabEventSchema,
  parseEnv,
  PORTS,
} from '@integris/shared';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { InternalApi } from './api-client.js';
import { createCollabServer } from './server.js';

const env = parseEnv(collabEnvSchema, process.env);
const logger = pino({ name: 'collab', level: env.NODE_ENV === 'production' ? 'info' : 'debug' });
const collab = createCollabServer({
  port: PORTS.collab,
  logger,
  api: new InternalApi(env.API_INTERNAL_COLLAB_URL, env.COLLAB_INTERNAL_SECRET),
  webOrigins: env.WEB_ORIGINS,
  recheckMs: env.COLLAB_RECHECK_SECONDS * 1000,
});

// Events of the API: files replaced or deleted, rights or project state changed. The ACL user
// `collab` may only subscribe to their channel: no INFO for the ready check.
const subscriber = new Redis(env.COLLAB_REDIS_URL, { enableReadyCheck: false });
subscriber.on('message', (_channel: string, message: string) => {
  let event;
  try {
    event = collabEventSchema.parse(JSON.parse(message));
  } catch {
    logger.warn('invalid collaboration event');
    return;
  }
  collab.handleEvent(event).catch((error: unknown) => logger.warn({ err: error }, 'event failed'));
});
await subscriber.subscribe(COLLAB_EVENTS_CHANNEL);

await collab.server.listen();
logger.info({ address: collab.server.address }, 'collab server listening');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'collab server stopping');
    void collab
      .destroy()
      .then(() => subscriber.quit())
      .then(() => process.exit(0));
  });
}
