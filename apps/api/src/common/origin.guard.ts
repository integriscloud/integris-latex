import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ApiConfig } from '../config/api-config.js';
import { ApiError } from './api-error.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence in depth (the session cookie is already SameSite=Lax): state-changing requests must
 * come from an allowed browser origin and carry a JSON body, which a cross-site form cannot send.
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
    if (!origin || !this.origins.has(origin) || !request.is('application/json')) {
      throw new ApiError(HttpStatus.FORBIDDEN, 'forbidden_origin');
    }
    return true;
  }
}
