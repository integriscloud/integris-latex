import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { CaptchaService } from './captcha.service.js';
import { OtpService } from './otp.service.js';
import { PasswordService } from './password.service.js';
import { RateLimitService } from './rate-limit.service.js';
import { SessionService } from './session.service.js';
import { SpacesService } from './spaces.service.js';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthGuard,
    CaptchaService,
    OtpService,
    PasswordService,
    RateLimitService,
    SessionService,
    SpacesService,
  ],
  exports: [AuthGuard, SessionService, AuthService],
})
export class AuthModule {}
