import { API_PREFIX } from '@integris/shared';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';

/** Middleware and prefix shared by the server and the tests. */
export function configureApp(app: NestExpressApplication): void {
  app.setGlobalPrefix(API_PREFIX);
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '64kb' });
  // Authentication answers carry personal data and must never be cached.
  app.use(
    `/${API_PREFIX}/auth`,
    (_req: unknown, res: { set(name: string, value: string): void }, next: () => void) => {
      res.set('Cache-Control', 'no-store');
      next();
    },
  );
}
