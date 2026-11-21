import {
  type CallHandler,
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  type NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { mergeMap, type Observable } from 'rxjs';
import type { AuthContext } from '../auth/auth.guard.js';
import { ApiError } from '../common/api-error.js';
import { PrismaService } from '../prisma/prisma.service.js';

const SENSITIVE = 'admin:sensitive';

/** A back-office action that changes something: it needs a recent SMS code (step 14). */
export const Sensitive = () => SetMetadata(SENSITIVE, true);

type AdminRequest = Request & { auth?: AuthContext };

/**
 * Back-office access, after AuthGuard (which reads the user from the database on every request):
 * only a super-administrator passes; anyone else gets "not found", as if the back-office did not
 * exist. Sensitive actions also need the back-office reauthentication of this session.
 */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const auth = request.auth;
    if (!auth?.user.isSuperAdmin || auth.user.disabledAt) {
      throw new ApiError(HttpStatus.NOT_FOUND, 'admin_not_found');
    }
    const sensitive = this.reflector.getAllAndOverride<boolean>(SENSITIVE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (sensitive) {
      const until = auth.session.adminReauthUntil ?? 0;
      if (until <= Math.floor(Date.now() / 1000)) {
        throw new ApiError(HttpStatus.FORBIDDEN, 'admin_reauth_required');
      }
    }
    return true;
  }
}

/**
 * Every consultation of the back-office is written in the audit log (who, which page and
 * parameters, IP); changes write their own, more precise entry in their transaction.
 */
@Injectable()
export class AdminAuditInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    if (request.method !== 'GET' || !request.auth) return next.handle();
    const actorId = request.auth.user.id;
    const route = (request.route as { path?: string } | undefined)?.path ?? request.path;
    // Written before the answer leaves: a consultation that cannot be journaled is not served.
    return next.handle().pipe(
      mergeMap(async (value: unknown) => {
        await this.prisma.client.auditLog.create({
          data: {
            actorId,
            action: 'ADMIN_VIEWED',
            targetType: 'BackOffice',
            targetId: route.slice(0, 200),
            metadata: {
              params: request.params as Record<string, string>,
              query: request.query as Record<string, string>,
            },
            ip: request.ip ?? null,
          },
        });
        return value;
      }),
    );
  }
}
