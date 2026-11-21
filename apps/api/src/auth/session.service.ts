import { SESSION_COOKIE } from '@integris/shared';
import { Injectable } from '@nestjs/common';
import type { CookieOptions, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { ApiConfig } from '../config/api-config.js';
import { RedisService } from '../redis/redis.service.js';
import { sha256 } from './keys.js';

const DAY = 86_400;

export interface SessionData {
  userId: string;
  spaceId: string | null;
  createdAt: number;
  // Unix seconds after which the session is refused even if active.
  absoluteExpiresAt: number;
  // Unix seconds until which the e-mail and the password can be changed (recent SMS code).
  reauthUntil?: number;
  // Unix seconds until which the back-office allows sensitive actions (super-administrators).
  adminReauthUntil?: number;
}

export interface Session extends SessionData {
  // Hash of the cookie value; the cookie value itself is never stored.
  key: string;
}

const sessionKey = (hash: string) => `sess:${hash}`;
const userSessionsKey = (userId: string) => `user-sessions:${userId}`;

/**
 * Server-side sessions in Redis. The cookie holds 32 random bytes; Redis stores their SHA-256.
 * Sessions slide with activity up to an absolute lifetime and can all be revoked per user.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly redis: RedisService,
    private readonly config: ApiConfig,
  ) {}

  private get idleSeconds(): number {
    return this.config.env.SESSION_IDLE_DAYS * DAY;
  }

  private get maxSeconds(): number {
    return this.config.env.SESSION_MAX_DAYS * DAY;
  }

  cookieOptions(): CookieOptions {
    return { httpOnly: true, secure: true, sameSite: 'lax', path: '/' };
  }

  /** Creates a new session (new id at every login: no fixation) and sets the cookie. */
  async create(res: Response, userId: string, spaceId: string | null): Promise<Session> {
    const id = randomBytes(32).toString('base64url');
    const key = sha256(id);
    const now = Math.floor(Date.now() / 1000);
    const data: SessionData = {
      userId,
      spaceId,
      createdAt: now,
      absoluteExpiresAt: now + this.maxSeconds,
    };
    await this.redis.client
      .multi()
      .set(sessionKey(key), JSON.stringify(data), 'EX', this.idleSeconds)
      .sadd(userSessionsKey(userId), key)
      .expire(userSessionsKey(userId), this.maxSeconds)
      .exec();
    res.cookie(SESSION_COOKIE, id, { ...this.cookieOptions(), maxAge: this.maxSeconds * 1000 });
    return { key, ...data };
  }

  /** Reads a session from its cookie value and extends its idle lifetime. */
  async read(cookieValue: string | undefined): Promise<Session | null> {
    if (!cookieValue || cookieValue.length > 128) return null;
    const key = sha256(cookieValue);
    const raw = await this.redis.client.get(sessionKey(key));
    if (!raw) return null;
    const data = JSON.parse(raw) as SessionData;
    const remaining = data.absoluteExpiresAt - Math.floor(Date.now() / 1000);
    if (remaining <= 0) {
      await this.destroy({ key, ...data });
      return null;
    }
    await this.redis.client.expire(sessionKey(key), Math.min(this.idleSeconds, remaining));
    return { key, ...data };
  }

  /** Reads a session without extending it (periodic checks of open collaboration sockets). */
  async peek(cookieValue: string | undefined): Promise<Session | null> {
    if (!cookieValue || cookieValue.length > 128) return null;
    const key = sha256(cookieValue);
    const raw = await this.redis.client.get(sessionKey(key));
    if (!raw) return null;
    const data = JSON.parse(raw) as SessionData;
    if (data.absoluteExpiresAt <= Math.floor(Date.now() / 1000)) return null;
    return { key, ...data };
  }

  /** Changes the open space or the reauthentication time, keeping the remaining lifetime. */
  async update(
    session: Session,
    patch: Partial<Pick<SessionData, 'spaceId' | 'reauthUntil' | 'adminReauthUntil'>>,
  ): Promise<void> {
    const data: SessionData = {
      userId: session.userId,
      spaceId: session.spaceId,
      createdAt: session.createdAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
      reauthUntil: session.reauthUntil,
      adminReauthUntil: session.adminReauthUntil,
      ...patch,
    };
    await this.redis.client.set(sessionKey(session.key), JSON.stringify(data), 'KEEPTTL', 'XX');
  }

  async destroy(session: Pick<Session, 'key' | 'userId'>): Promise<void> {
    await this.redis.client
      .multi()
      .del(sessionKey(session.key))
      .srem(userSessionsKey(session.userId), session.key)
      .exec();
  }

  /** Revokes every session of a user, except `keepKey` when given. */
  async destroyAll(userId: string, keepKey?: string): Promise<void> {
    const keys = await this.redis.client.smembers(userSessionsKey(userId));
    const revoked = keys.filter((key) => key !== keepKey);
    if (revoked.length === 0) return;
    await this.redis.client
      .multi()
      .del(...revoked.map(sessionKey))
      .srem(userSessionsKey(userId), ...revoked)
      .exec();
  }

  clearCookie(res: Response): void {
    res.clearCookie(SESSION_COOKIE, this.cookieOptions());
  }
}
