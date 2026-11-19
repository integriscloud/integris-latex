import {
  type AuthConfig,
  captchaChallengeRequestSchema,
  emailChangeSchema,
  type MeResponse,
  otpLoginSchema,
  otpRequestSchema,
  passwordChangeSchema,
  passwordForgotSchema,
  passwordLoginSchema,
  passwordResetSchema,
  reauthRequestSchema,
  reauthVerifySchema,
  selectSpaceSchema,
  SESSION_COOKIE,
  signupSchema,
  tokenSchema,
  updatePreferencesSchema,
  type UserPreferences,
} from '@integris/shared';
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Challenge } from 'altcha-lib';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { ApiError } from '../common/api-error.js';
import { ApiZodBody, ZodBody } from '../common/zod-body.js';
import { Auth, type AuthContext, AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';

/** Client address (behind Nginx, from X-Forwarded-For). Refused when unknown. */
const clientIp = (request: Request) => {
  if (!request.ip) throw new ApiError(HttpStatus.BAD_REQUEST, 'invalid_request');
  return request.ip;
};

const sessionCookie = (request: Request) =>
  (request.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Allowed dial codes and code length, for the sign-in forms. */
  @Get('config')
  config(): AuthConfig {
    return this.auth.publicConfig();
  }

  /**
   * A new proof-of-work challenge, solved by the browser when a CAPTCHA is required. It is signed
   * for one action and its target (POST: the phone or e-mail never appears in a URL or a log).
   */
  @Post('captcha')
  @HttpCode(200)
  @ApiZodBody(captchaChallengeRequestSchema)
  captchaChallenge(
    @ZodBody(captchaChallengeRequestSchema) body: z.infer<typeof captchaChallengeRequestSchema>,
    @Req() request: Request,
  ): Promise<Challenge> {
    return this.auth.captchaChallenge(body, sessionCookie(request));
  }

  /** Sends a code by SMS. 428 when a CAPTCHA is required, 429 when a limit is reached. */
  @Post('otp')
  @HttpCode(200)
  @ApiZodBody(otpRequestSchema)
  requestOtp(
    @ZodBody(otpRequestSchema) body: z.infer<typeof otpRequestSchema>,
    @Req() request: Request,
  ) {
    return this.auth.requestOtp(body, clientIp(request));
  }

  @Post('signup')
  @HttpCode(200)
  @ApiZodBody(signupSchema)
  @ApiOkResponse({
    description: 'Account created (or existing account of this number); signed in.',
  })
  signup(
    @ZodBody(signupSchema) body: z.infer<typeof signupSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeResponse> {
    return this.auth.signup(body, clientIp(request), res, sessionCookie(request));
  }

  @Post('login/otp')
  @HttpCode(200)
  @ApiZodBody(otpLoginSchema)
  loginWithOtp(
    @ZodBody(otpLoginSchema) body: z.infer<typeof otpLoginSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeResponse> {
    return this.auth.loginWithOtp(body, clientIp(request), res, sessionCookie(request));
  }

  @Post('login/password')
  @HttpCode(200)
  @ApiZodBody(passwordLoginSchema)
  loginWithPassword(
    @ZodBody(passwordLoginSchema) body: z.infer<typeof passwordLoginSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeResponse> {
    return this.auth.loginWithPassword(body, clientIp(request), res, sessionCookie(request));
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@Auth() auth: AuthContext): Promise<MeResponse> {
    return this.auth.me(auth);
  }

  /** Settings kept on the account, such as the spell checker of the editor. */
  @Patch('preferences')
  @UseGuards(AuthGuard)
  @ApiZodBody(updatePreferencesSchema)
  updatePreferences(
    @Auth() auth: AuthContext,
    @ZodBody(updatePreferencesSchema) body: z.infer<typeof updatePreferencesSchema>,
  ): Promise<UserPreferences> {
    return this.auth.updatePreferences(auth, body);
  }

  @Post('space')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @ApiZodBody(selectSpaceSchema)
  selectSpace(
    @Auth() auth: AuthContext,
    @ZodBody(selectSpaceSchema) body: z.infer<typeof selectSpaceSchema>,
  ): Promise<MeResponse> {
    return this.auth.selectSpace(auth, body.spaceId);
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  logout(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response): Promise<void> {
    return this.auth.logout(auth, res);
  }

  /** Signs out every session of the user, on every device. */
  @Post('logout-all')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  logoutEverywhere(
    @Auth() auth: AuthContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    return this.auth.logoutEverywhere(auth, res);
  }

  /** Sends a confirmation link to a new e-mail address; needs a recent reauthentication. */
  @Post('email')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  @ApiZodBody(emailChangeSchema)
  requestEmail(
    @Auth() auth: AuthContext,
    @ZodBody(emailChangeSchema) body: z.infer<typeof emailChangeSchema>,
    @Req() request: Request,
  ): Promise<void> {
    return this.auth.changeEmail(auth, body.email, body.locale, clientIp(request));
  }

  /** Confirms an e-mail address from the link (works without being signed in). */
  @Post('email/verify')
  @HttpCode(204)
  @ApiZodBody(tokenSchema)
  verifyEmail(@ZodBody(tokenSchema) body: z.infer<typeof tokenSchema>): Promise<void> {
    return this.auth.verifyEmail(body.token);
  }

  /** Sends a code to the account phone before an e-mail or password change. */
  @Post('reauth/otp')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @ApiZodBody(reauthRequestSchema)
  requestReauth(
    @Auth() auth: AuthContext,
    @ZodBody(reauthRequestSchema) body: z.infer<typeof reauthRequestSchema>,
    @Req() request: Request,
  ) {
    return this.auth.requestReauth(auth, body.locale, body.captcha, clientIp(request));
  }

  /** Confirms the identity with that code; changes are then allowed for 10 minutes. */
  @Post('reauth')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @ApiZodBody(reauthVerifySchema)
  verifyReauth(
    @Auth() auth: AuthContext,
    @ZodBody(reauthVerifySchema) body: z.infer<typeof reauthVerifySchema>,
    @Req() request: Request,
  ) {
    return this.auth.verifyReauth(auth, body.code, body.captcha, clientIp(request));
  }

  /** Sets or changes the password; needs a recent reauthentication. */
  @Post('password')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  @ApiZodBody(passwordChangeSchema)
  changePassword(
    @Auth() auth: AuthContext,
    @ZodBody(passwordChangeSchema) body: z.infer<typeof passwordChangeSchema>,
  ): Promise<void> {
    return this.auth.changePassword(auth, body.newPassword);
  }

  @Post('password/forgot')
  @HttpCode(204)
  @ApiZodBody(passwordForgotSchema)
  forgotPassword(
    @ZodBody(passwordForgotSchema) body: z.infer<typeof passwordForgotSchema>,
    @Req() request: Request,
  ): Promise<void> {
    return this.auth.forgotPassword(body.email, body.locale, body.captcha, clientIp(request));
  }

  @Post('password/reset')
  @HttpCode(204)
  @ApiZodBody(passwordResetSchema)
  resetPassword(
    @ZodBody(passwordResetSchema) body: z.infer<typeof passwordResetSchema>,
  ): Promise<void> {
    return this.auth.resetPassword(body.token, body.newPassword);
  }
}
