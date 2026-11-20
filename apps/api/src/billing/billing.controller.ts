import {
  type BillingOverview,
  type BillingQuote,
  type CheckoutResponse,
  checkoutRequestSchema,
  type CheckoutRequest,
  type PaymentStatusView,
  readNoticesSchema,
} from '@integris/shared';
import { Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { Auth, type AuthContext, AuthGuard } from '../auth/auth.guard.js';
import { ipOf } from '../common/request-ip.js';
import { ApiZodBody, ZodBody } from '../common/zod-body.js';
import { BillingService } from './billing.service.js';

const idSchema = z.string().min(1).max(64);

/** "Abonnement": plans paid by the signed-in user, quotes, payments, receipts and the trial. */
@ApiTags('billing')
@Controller('billing')
@UseGuards(AuthGuard)
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  overview(@Auth() auth: AuthContext): Promise<BillingOverview> {
    return this.billing.overview(auth.user);
  }

  /** Price of an order, computed from the `Plan` table (nothing is written). */
  @Post('quote')
  @HttpCode(200)
  @ApiZodBody(checkoutRequestSchema)
  quote(
    @Auth() auth: AuthContext,
    @ZodBody(checkoutRequestSchema) body: CheckoutRequest,
  ): Promise<BillingQuote> {
    return this.billing.quote(auth.user, body);
  }

  /** Creates the payment and returns the LigdiCash page (null: applied, nothing to pay). */
  @Post('checkout')
  @ApiZodBody(checkoutRequestSchema)
  checkout(
    @Auth() auth: AuthContext,
    @ZodBody(checkoutRequestSchema) body: CheckoutRequest,
    @Req() request: Request,
  ): Promise<CheckoutResponse> {
    return this.billing.checkout(auth.user, body, ipOf(request));
  }

  @Get('payments/:paymentId')
  payment(
    @Auth() auth: AuthContext,
    @Param('paymentId') paymentId: string,
  ): Promise<PaymentStatusView> {
    return this.billing.paymentStatus(auth.user, idSchema.parse(paymentId));
  }

  @Post('payments/:paymentId/receipt')
  @HttpCode(204)
  async resend(@Auth() auth: AuthContext, @Param('paymentId') paymentId: string): Promise<void> {
    await this.billing.resendReceipt(auth.user, idSchema.parse(paymentId));
  }

  @Post('trial')
  @HttpCode(204)
  async trial(@Auth() auth: AuthContext, @Req() request: Request): Promise<void> {
    await this.billing.startTrial(auth.user, ipOf(request));
  }

  @Post('notices/read')
  @HttpCode(204)
  @ApiZodBody(readNoticesSchema)
  async readNotices(
    @Auth() auth: AuthContext,
    @ZodBody(readNoticesSchema) body: z.infer<typeof readNoticesSchema>,
  ): Promise<void> {
    await this.billing.readNotices(auth.user, body.ids);
  }
}
