import { SESSION_COOKIE } from '@integris/shared';
import type { User } from '@integris/db';
import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiError } from '../common/api-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type Session, SessionService } from './session.service.js';

export interface AuthContext {
  user: User;
  session: Session;
}

type AuthenticatedRequest = Request & { auth?: AuthContext };

/** Requires a valid session of an enabled user; checked on every request. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const cookies = request.cookies as Record<string, string> | undefined;
    const session = await this.sessions.read(cookies?.[SESSION_COOKIE]);
    if (!session) throw new ApiError(HttpStatus.UNAUTHORIZED, 'unauthenticated');
    const user = await this.prisma.client.user.findUnique({ where: { id: session.userId } });
    if (!user || user.disabledAt) {
      await this.sessions.destroy(session);
      throw new ApiError(HttpStatus.UNAUTHORIZED, 'unauthenticated');
    }
    request.auth = { user, session };
    return true;
  }
}

/** The authenticated user and session, set by AuthGuard. */
export const Auth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().auth!,
);
