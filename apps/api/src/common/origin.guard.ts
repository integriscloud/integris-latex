import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ApiConfig } from '../config/api-config.js';
import { ApiError } from './api-error.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Body types a cross-site HTML form cannot send: JSON, and raw binary bodies for file uploads
 * (forms can only send urlencoded, multipart or text/plain bodies).
 */
const ALLOWED_TYPES = ['application/json', 'application/octet-stream', 'application/zip'];

/**
 * CSRF defence in depth (the session cookie is already SameSite=Lax): state-changing requests must
 * come from an allowed browser origin and carry a JSON or raw binary body.
 */
@Injectable()
export class OriginGuard implements CanActivate {
  private readonly origins: Set<string>;

  constructor(config: ApiConfig) {
    this.origins = new Set(config.env.WEB_ORIGINS.map((origin) => new URL(origin).origin));
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(request.method)) return true;
    const origin = request.get('origin');
    if (!origin || !this.origins.has(origin) || !request.is(ALLOWED_TYPES)) {
      throw new ApiError(HttpStatus.FORBIDDEN, 'forbidden_origin');
    }
    return true;
  }
}
