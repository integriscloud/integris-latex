import type { User } from '@integris/db';
import {
  type AuthConfig,
  type CaptchaAction,
  type CaptchaChallengeRequest,
  dialCodeOf,
  type Locale,
  type MeResponse,
  normalizePhone,
  type OtpLoginRequest,
  type OtpPurpose,
  type OtpRequest,
  type PasswordLoginRequest,
  type SignupRequest,
} from '@integris/shared';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { randomBytes } from 'node:crypto';
import { ApiError } from '../common/api-error.js';
import { ApiConfig } from '../config/api-config.js';
import { MAIL_SENDER, type MailSender } from '../mail/mail-sender.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { emailVerificationMail, passwordResetMail } from './auth-messages.js';
import type { AuthContext } from './auth.guard.js';
import { CaptchaService } from './captcha.service.js';
import { sha256 } from './keys.js';
import { OtpService } from './otp.service.js';
import { PasswordService } from './password.service.js';
import { RateLimitService } from './rate-limit.service.js';
import { type Session, SessionService } from './session.service.js';
import { SpacesService } from './spaces.service.js';

const EMAIL_TOKEN_SECONDS = 86_400;
const RESET_TOKEN_SECONDS = 1800;

const emailTokenKey = (token: string) => `email-verify:${sha256(token)}`;
const pendingEmailKey = (userId: string) => `email-pending:${userId}`;
const resetTokenKey = (token: string) => `password-reset:${sha256(token)}`;
const emailId = (email: string) => `email:${email}`;
// Pending e-mail links (confirmation, password reset) of a user, revoked together.
const userTokensKey = (id: string) => `user-tokens:${id}`;
const now = () => Math.floor(Date.now() / 1000);

const isUniqueViolation = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';

/** Sign-up, sign-in (SMS code or e-mail and password), sessions, spaces and account security. */
@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');

  constructor(
    private readonly config: ApiConfig,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly limits: RateLimitService,
    private readonly captcha: CaptchaService,
    private readonly otp: OtpService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly spaces: SpacesService,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
  ) {}

  publicConfig(): AuthConfig {
    const env = this.config.env;
    return {
      allowedDialCodes: env.AUTH_ALLOWED_DIAL_CODES,
      otpLength: env.OTP_LENGTH,
      otpResendSeconds: env.OTP_RESEND_SECONDS,
      passwordMinLength: env.PASSWORD_MIN_LENGTH,
    };
  }

  /** E.164 number of an allowed country, or an error. */
  private phone(input: string, dialCode: string): string {
    const phone = normalizePhone(input, dialCode);
    if (!phone) throw new ApiError(HttpStatus.BAD_REQUEST, 'invalid_phone');
    const country = dialCodeOf(phone);
    if (!country || !this.config.env.AUTH_ALLOWED_DIAL_CODES.includes(country)) {
      throw new ApiError(HttpStatus.FORBIDDEN, 'country_not_allowed');
    }
    return phone;
  }

  /**
   * Sends a code. The answer never depends on whether an account exists for the number: only the
   * owner of the phone learns it, after entering the code.
   */
  async requestOtp(body: OtpRequest, ip: string): Promise<{ resendAfter: number }> {
    const phone = this.phone(body.phone, body.dialCode);
    const state = await this.limits.checkAttempt(phone, ip);
    await this.captcha.enforce(state, body.captcha, 'otp', phone);
    const resendAfter = await this.otp.send(phone, body.purpose, body.locale, ip);
    return { resendAfter };
  }

  /**
   * Runs one guarded attempt: the attempt is counted before the check (so parallel requests
   * cannot skip the CAPTCHA or the lock), given back when the CAPTCHA refuses it, and cleared
   * on success. The CAPTCHA must be signed for this action and identifier. `check` throws the
   * error to return on failure.
   */
  private async attempt<T>(
    identifier: string,
    ip: string,
    captcha: { action: CaptchaAction; payload: string | undefined },
    check: () => Promise<T>,
  ): Promise<T> {
    const state = await this.limits.beginAttempt(identifier, ip);
    try {
      await this.captcha.enforce(state, captcha.payload, captcha.action, identifier);
    } catch (error) {
      await this.limits.release(identifier, ip);
      throw error;
    }
    const result = await check();
    await this.limits.succeed(identifier, ip);
    return result;
  }

  private async verifyCode(
    phone: string,
    purpose: OtpPurpose,
    code: string,
    captcha: { action: CaptchaAction; payload: string | undefined },
    ip: string,
  ): Promise<void> {
    await this.attempt(phone, ip, captcha, async () => {
      const result = await this.otp.check(phone, purpose, code);
      if (result !== 'ok') throw new ApiError(HttpStatus.BAD_REQUEST, result);
    });
  }

  /**
   * Creates the account once the number is proven. If the number already has an account, its
   * owner has just proven possession of the phone, so they are signed in to it unchanged.
   */
  async signup(
    body: SignupRequest,
    ip: string,
    res: Response,
    previous?: string,
  ): Promise<MeResponse> {
    const phone = this.phone(body.phone, body.dialCode);
    await this.verifyCode(
      phone,
      'signup',
      body.code,
      { action: 'signup', payload: body.captcha },
      ip,
    );

    let user = await this.prisma.client.user.findUnique({ where: { phone } });
    if (!user) {
      try {
        user = await this.prisma.client.user.create({
          data: {
            phone,
            phoneVerifiedAt: new Date(),
            displayName: `${body.firstName} ${body.lastName}`,
            locale: body.locale,
          },
        });
        this.logger.log(`account created ${user.id}`);
        if (body.email) {
          await this.requestEmailVerification(user, body.email, body.locale, ip).catch(() => {
            // The account exists; the address can be confirmed later from the account page.
          });
        }
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        user = await this.prisma.client.user.findUniqueOrThrow({ where: { phone } });
      }
    }
    return this.startSession(user, res, previous);
  }

  async loginWithOtp(
    body: OtpLoginRequest,
    ip: string,
    res: Response,
    previous?: string,
  ): Promise<MeResponse> {
    const phone = this.phone(body.phone, body.dialCode);
    await this.verifyCode(
      phone,
      'login',
      body.code,
      { action: 'login_otp', payload: body.captcha },
      ip,
    );
    const user = await this.prisma.client.user.findUnique({ where: { phone } });
    if (!user) throw new ApiError(HttpStatus.NOT_FOUND, 'no_account');
    return this.startSession(user, res, previous);
  }

  /** E-mail and password sign-in; only for a verified e-mail, with one generic error. */
  async loginWithPassword(
    body: PasswordLoginRequest,
    ip: string,
    res: Response,
    previous?: string,
  ): Promise<MeResponse> {
    const captcha = { action: 'login_password' as const, payload: body.captcha };
    const user = await this.attempt(emailId(body.email), ip, captcha, async () => {
      const found = await this.prisma.client.user.findUnique({ where: { email: body.email } });
      const valid = await this.passwords.verify(
        found?.emailVerifiedAt ? found.passwordHash : null,
        body.password,
      );
      if (!found || !valid) throw new ApiError(HttpStatus.UNAUTHORIZED, 'invalid_credentials');
      return found;
    });
    return this.startSession(user, res, previous);
  }

  /** Opens a new session; the session the browser had before, if any, is closed. */
  private async startSession(user: User, res: Response, previous?: string): Promise<MeResponse> {
    if (user.disabledAt) throw new ApiError(HttpStatus.FORBIDDEN, 'account_disabled');
    const old = await this.sessions.read(previous);
    if (old) await this.sessions.destroy(old);
    const spaces = await this.spaces.list(user.id);
    const session = await this.sessions.create(res, user.id, this.spaces.initialSpace(spaces));
    this.logger.log(`signed in ${user.id}`);
    return this.describe(user, session, spaces);
  }

  async me({ user, session }: AuthContext): Promise<MeResponse> {
    return this.describe(user, session, await this.spaces.list(user.id));
  }

  private async describe(
    user: User,
    session: Session,
    spaces: MeResponse['spaces'],
  ): Promise<MeResponse> {
    const pending = await this.redis.client.get(pendingEmailKey(user.id));
    const pendingEmail = pending ? (JSON.parse(pending) as { email: string }).email : null;
    const current = spaces.some((space) => space.id === session.spaceId) ? session.spaceId : null;
    return {
      user: {
        id: user.id,
        displayName: user.displayName,
        phone: user.phone,
        email: user.emailVerifiedAt ? user.email : null,
        pendingEmail,
        hasPassword: user.passwordHash !== null,
        locale: user.locale,
      },
      spaces,
      currentSpaceId: current,
      reauthUntil: session.reauthUntil && session.reauthUntil > now() ? session.reauthUntil : null,
    };
  }

  /** Switches space without signing in again; refuses a space the user does not belong to. */
  async selectSpace(auth: AuthContext, spaceId: string): Promise<MeResponse> {
    const spaces = await this.spaces.list(auth.user.id);
    if (!spaces.some((space) => space.id === spaceId)) {
      throw new ApiError(HttpStatus.FORBIDDEN, 'space_not_allowed');
    }
    await this.sessions.update(auth.session, { spaceId });
    await this.prisma.client.user.update({
      where: { id: auth.user.id },
      data: { lastSpace: spaceId },
    });
    return this.describe(auth.user, { ...auth.session, spaceId }, spaces);
  }

  async logout({ session }: AuthContext, res: Response): Promise<void> {
    await this.sessions.destroy(session);
    this.sessions.clearCookie(res);
  }

  async logoutEverywhere({ user }: AuthContext, res: Response): Promise<void> {
    await this.sessions.destroyAll(user.id);
    this.sessions.clearCookie(res);
  }

  /**
   * A CAPTCHA challenge signed for one action and its target: the phone number or e-mail address
   * of the request, or the signed-in user for reauthentication.
   */
  async captchaChallenge(body: CaptchaChallengeRequest, sessionCookie: string | undefined) {
    let identifier: string;
    if (body.action === 'login_password' || body.action === 'password_forgot') {
      if (!body.email) throw new ApiError(HttpStatus.BAD_REQUEST, 'invalid_request');
      identifier = emailId(body.email);
    } else if (body.action === 'reauth_otp' || body.action === 'reauth') {
      const session = await this.sessions.read(sessionCookie);
      const user = session
        ? await this.prisma.client.user.findUnique({ where: { id: session.userId } })
        : null;
      if (!user || user.disabledAt) throw new ApiError(HttpStatus.UNAUTHORIZED, 'unauthenticated');
      identifier = this.accountPhone(user);
    } else {
      identifier = this.phone(body.phone ?? '', body.dialCode ?? '');
    }
    return this.captcha.createChallenge(body.action, identifier);
  }

  private accountPhone(user: User): string {
    if (!user.phone) throw new ApiError(HttpStatus.BAD_REQUEST, 'no_phone');
    return user.phone;
  }

  /** Sends a code to the account phone to confirm the identity before a sensitive change. */
  async requestReauth(
    { user }: AuthContext,
    locale: Locale,
    captcha: string | undefined,
    ip: string,
  ): Promise<{ resendAfter: number }> {
    const phone = this.accountPhone(user);
    const state = await this.limits.checkAttempt(phone, ip);
    await this.captcha.enforce(state, captcha, 'reauth_otp', phone);
    return { resendAfter: await this.otp.send(phone, 'reauth', locale, ip) };
  }

  /** Checks the reauthentication code; e-mail and password changes are allowed for a while. */
  async verifyReauth(
    { user, session }: AuthContext,
    code: string,
    captcha: string | undefined,
    ip: string,
  ): Promise<{ reauthUntil: number }> {
    const phone = this.accountPhone(user);
    await this.verifyCode(phone, 'reauth', code, { action: 'reauth', payload: captcha }, ip);
    const reauthUntil = now() + this.config.env.AUTH_REAUTH_SECONDS;
    await this.sessions.update(session, { reauthUntil });
    return { reauthUntil };
  }

  private requireReauth(session: Session): void {
    if (!session.reauthUntil || session.reauthUntil <= now()) {
      throw new ApiError(HttpStatus.FORBIDDEN, 'reauth_required');
    }
  }

  /** Remembers a pending e-mail link so that it can be revoked with the others. */
  private async trackToken(id: string, key: string): Promise<void> {
    // Kept as long as the longest link (keys of expired links are simply already gone).
    await this.redis.client
      .multi()
      .sadd(userTokensKey(id), key)
      .expire(userTokensKey(id), EMAIL_TOKEN_SECONDS)
      .exec();
  }

  /** Revokes every pending confirmation and password reset link of a user. */
  private async revokeTokens(id: string): Promise<void> {
    const keys = await this.redis.client.smembers(userTokensKey(id));
    await this.redis.client.del(userTokensKey(id), pendingEmailKey(id), ...keys);
  }

  /** Adds or changes the e-mail address: needs a recent confirmation by SMS code. */
  async changeEmail(auth: AuthContext, email: string, locale: Locale, ip: string): Promise<void> {
    this.requireReauth(auth.session);
    await this.requestEmailVerification(auth.user, email, locale, ip);
  }

  /** Sends a confirmation link; the address is attached to the account only once confirmed. */
  async requestEmailVerification(
    user: User,
    email: string,
    locale: Locale,
    ip: string,
  ): Promise<void> {
    if (user.emailVerifiedAt && user.email === email) return;
    await this.limits.consumeSend(emailId(email), ip);
    const token = randomBytes(32).toString('base64url');
    await this.redis.client
      .multi()
      .set(
        emailTokenKey(token),
        JSON.stringify({ userId: user.id, email }),
        'EX',
        EMAIL_TOKEN_SECONDS,
      )
      // Only the latest link stays valid: verifyEmail checks this hash.
      .set(
        pendingEmailKey(user.id),
        JSON.stringify({ email, tokenHash: sha256(token) }),
        'EX',
        EMAIL_TOKEN_SECONDS,
      )
      .exec();
    await this.trackToken(user.id, emailTokenKey(token));
    const link = `${this.config.env.PUBLIC_WEB_URL}/${locale}/verify-email#token=${token}`;
    await this.mail.send(emailVerificationMail[locale](email, link));
  }

  async verifyEmail(token: string): Promise<void> {
    const raw = await this.redis.client.getdel(emailTokenKey(token));
    if (!raw) throw new ApiError(HttpStatus.BAD_REQUEST, 'invalid_token');
    const { userId: id, email } = JSON.parse(raw) as { userId: string; email: string };
    const pending = await this.redis.client.get(pendingEmailKey(id));
    if (!pending || (JSON.parse(pending) as { tokenHash: string }).tokenHash !== sha256(token)) {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'invalid_token');
    }
    try {
      await this.prisma.client.user.update({
        where: { id },
        data: { email, emailVerifiedAt: new Date() },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError(HttpStatus.CONFLICT, 'email_taken');
      throw error;
    }
    // The account e-mail changed: links sent before (to this or another address) stop working.
    await this.revokeTokens(id);
  }

  /**
   * Sets or changes the password (used to sign in with the verified e-mail). Needs a recent
   * confirmation by SMS code and signs out every other session.
   */
  async changePassword({ user, session }: AuthContext, newPassword: string): Promise<void> {
    this.requireReauth(session);
    if (!user.emailVerifiedAt) throw new ApiError(HttpStatus.BAD_REQUEST, 'email_required');
    this.passwords.assertStrong(newPassword);
    await this.prisma.client.user.update({
      where: { id: user.id },
      data: { passwordHash: await this.passwords.hash(newPassword) },
    });
    await this.sessions.destroyAll(user.id, session.key);
  }

  /** Always answers the same way, whether or not the address belongs to an account. */
  async forgotPassword(email: string, locale: Locale, captcha: string | undefined, ip: string) {
    const id = emailId(email);
    const state = await this.limits.checkAttempt(id, ip);
    await this.captcha.enforce(state, captcha, 'password_forgot', id);
    await this.limits.consumeSend(id, ip);
    const user = await this.prisma.client.user.findUnique({ where: { email } });
    if (!user?.emailVerifiedAt || user.disabledAt) return;
    const token = randomBytes(32).toString('base64url');
    await this.redis.client.set(resetTokenKey(token), user.id, 'EX', RESET_TOKEN_SECONDS);
    await this.trackToken(user.id, resetTokenKey(token));
    const link = `${this.config.env.PUBLIC_WEB_URL}/${locale}/reset-password#token=${token}`;
    // Not awaited: the answer must take the same time whether or not the account exists.
    void this.mail.send(passwordResetMail[locale](email, link)).catch((error: unknown) => {
      this.logger.error(`password reset e-mail failed: ${String(error)}`);
    });
  }

  /** Sets a new password from a reset link and signs out every session. */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    this.passwords.assertStrong(newPassword);
    const id = await this.redis.client.getdel(resetTokenKey(token));
    if (!id) throw new ApiError(HttpStatus.BAD_REQUEST, 'invalid_token');
    await this.prisma.client.user.update({
      where: { id },
      data: { passwordHash: await this.passwords.hash(newPassword) },
    });
    await this.revokeTokens(id);
    await this.sessions.destroyAll(id);
  }
}
