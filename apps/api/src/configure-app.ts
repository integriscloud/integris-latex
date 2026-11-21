import { API_PREFIX, MAX_PROJECT_FILE_BYTES, type ProjectErrorCode } from '@integris/shared';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import { ApiConfig } from './config/api-config.js';

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

/** Refuses at once an upload announced larger than its limit (the handler checks it again). */
const maxLength =
  (limit: number, code: ProjectErrorCode): Middleware =>
  (req, res, next) => {
    if (Number(req.get('content-length') ?? 0) > limit) {
      res.status(413).json({ code });
      return;
    }
    next();
  };

const noStore: Middleware = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

/** Middleware and prefix shared by the server and the tests. */
export function configureApp(app: NestExpressApplication): void {
  const { env } = app.get(ApiConfig);
  app.setGlobalPrefix(API_PREFIX);
  app.use(cookieParser());
  app.use(
    `/${API_PREFIX}/projects/import`,
    maxLength(env.ZIP_MAX_ARCHIVE_BYTES, 'archive_too_large'),
  );
  app.use(
    new RegExp(`^/${API_PREFIX}/projects/[^/]+/files/upload`),
    maxLength(MAX_PROJECT_FILE_BYTES, 'file_too_large'),
  );
  app.useBodyParser('json', { limit: '64kb' });
  // Uploads (a ZIP archive, one project file) are raw bodies, never multipart. No global parser
  // reads them: the route handler does, after the guards (common/raw-body.ts).
  // Answers carrying personal data or user content must never be cached.
  for (const path of [
    'auth',
    'projects',
    'templates',
    'billing',
    'payments',
    'organizations',
    'supervisions',
    'org-invitations',
  ]) {
    app.use(`/${API_PREFIX}/${path}`, noStore);
  }
}
