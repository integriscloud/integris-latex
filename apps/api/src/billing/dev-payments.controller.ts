import { type SimulatedInvoice, simulatedPaymentSchema } from '@integris/shared';
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard.js';
import { ApiError } from '../common/api-error.js';
import { ZodBody } from '../common/zod-body.js';
import { ApiConfig } from '../config/api-config.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from './payment-provider.js';
import { SimulatedProvider } from './simulated.provider.js';

/**
 * Development only (PAYMENT_PROVIDER=simulated, never in production): the simulated LigdiCash
 * page reads its invoice and chooses the outcome. 404 otherwise. The outcome only feeds the
 * simulated status API: the payment is settled by the normal callback and verification path.
 */
@ApiExcludeController()
@Controller('payments/simulated')
@UseGuards(AuthGuard)
export class DevPaymentsController {
  constructor(
    private readonly config: ApiConfig,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  private simulator(): SimulatedProvider {
    if (
      this.config.env.NODE_ENV === 'production' ||
      !(this.provider instanceof SimulatedProvider)
    ) {
      throw new ApiError(HttpStatus.NOT_FOUND, 'payment_not_found');
    }
    return this.provider;
  }

  @Get(':token')
  async invoice(@Param('token') token: string): Promise<SimulatedInvoice> {
    const invoice = await this.simulator().read(token);
    if (!invoice) throw new ApiError(HttpStatus.NOT_FOUND, 'payment_not_found');
    return {
      token: invoice.token,
      amountXof: invoice.amountXof,
      description: invoice.description,
      returnUrl: invoice.returnUrl,
      cancelUrl: invoice.cancelUrl,
    };
  }

  @Post(':token')
  @HttpCode(204)
  async settle(
    @Param('token') token: string,
    @ZodBody(simulatedPaymentSchema) body: z.infer<typeof simulatedPaymentSchema>,
  ): Promise<void> {
    const settled = await this.simulator().settle(token, body.outcome);
    if (!settled) throw new ApiError(HttpStatus.NOT_FOUND, 'payment_not_found');
  }
}
