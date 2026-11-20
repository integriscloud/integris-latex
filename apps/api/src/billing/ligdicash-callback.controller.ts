import { Controller, HttpCode, Logger, Post, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { SkipOriginCheck } from '../common/origin.guard.js';
import { consumeLimit } from '../common/rate-limit.js';
import { readRawBody } from '../common/raw-body.js';
import { ipOf } from '../common/request-ip.js';
import { RedisService } from '../redis/redis.service.js';
import { PaymentProcessor } from './payment-processor.service.js';
import { LIGDICASH_CALLBACK_PATH } from './simulated.provider.js';

const PAYMENT_ID = /^[a-z0-9]{20,40}$/;
const CALLS_PER_MINUTE_PER_IP = 120;
const FORM_LIMIT = 64 * 1024;

/**
 * Our payment id in a LigdiCash callback: `custom_data` comes back as a list of
 * `{ keyof_customdata, valueof_customdata }` (JSON) or as `custom_data[i][...]` fields (form);
 * `external_id` joins the values of the keys containing "id" (only ours).
 */
export function paymentIdOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const fields = body as Record<string, unknown>;
  const candidates: unknown[] = [];
  const customData = fields.custom_data;
  if (Array.isArray(customData)) {
    for (const entry of customData) {
      if (entry && typeof entry === 'object') {
        const item = entry as Record<string, unknown>;
        if (item.keyof_customdata === 'transaction_id') candidates.push(item.valueof_customdata);
      }
    }
  } else if (customData && typeof customData === 'object') {
    candidates.push((customData as Record<string, unknown>).transaction_id);
  }
  for (const [key, value] of Object.entries(fields)) {
    const match = /^custom_data\[(\d+)\]\[keyof_customdata\]$/.exec(key);
    if (match && value === 'transaction_id') {
      candidates.push(fields[`custom_data[${match[1]}][valueof_customdata]`]);
    }
  }
  // external_id joins the transaction_id values with ";" (docs, "Vérifier le statut").
  if (typeof fields.external_id === 'string') candidates.push(...fields.external_id.split(';'));
  candidates.push(fields.transaction_id);
  const found = candidates.find((value) => typeof value === 'string' && PAYMENT_ID.test(value));
  return (found as string | undefined) ?? null;
}

/**
 * Callback of LigdiCash (sent twice: JSON, then form-urlencoded). Its content is never trusted
 * (LigdiCash does not sign it): it only names a payment, whose status is then read from the
 * LigdiCash API with the invoice token saved at its creation. Always 200 for an unknown or
 * already settled payment, so LigdiCash stops retrying; 500 when the check failed on our side.
 */
@ApiExcludeController()
@Controller()
export class LigdicashCallbackController {
  private readonly logger = new Logger(LigdicashCallbackController.name);

  constructor(
    private readonly processor: PaymentProcessor,
    private readonly redis: RedisService,
  ) {}

  @Post(LIGDICASH_CALLBACK_PATH)
  @SkipOriginCheck()
  @HttpCode(200)
  async callback(@Req() request: Request): Promise<{ ok: true }> {
    await consumeLimit(
      this.redis.client,
      `rl:ligdicash-callback:${ipOf(request) ?? 'unknown'}`,
      CALLS_PER_MINUTE_PER_IP,
      60,
    );
    let body: unknown = request.body;
    const parsed = body !== null && typeof body === 'object' && Object.keys(body).length > 0;
    // The form callback may already be parsed by the platform body parser; read it otherwise.
    if (!parsed && request.is('application/x-www-form-urlencoded')) {
      const raw = await readRawBody(
        request,
        'application/x-www-form-urlencoded',
        FORM_LIMIT,
        'invalid_request',
      );
      body = Object.fromEntries(new URLSearchParams(Buffer.from(raw).toString('utf8')));
    }
    const paymentId = paymentIdOf(body);
    if (!paymentId) {
      this.logger.warn('LigdiCash callback without a known transaction id');
      return { ok: true };
    }
    // Both callbacks of one payment arrive together: one status check is enough (the status page
    // and the scheduler check again), so a flood of callbacks never floods LigdiCash.
    const first = await this.redis.client.set(`rl:callback-check:${paymentId}`, '1', 'EX', 2, 'NX');
    if (first !== 'OK') return { ok: true };
    const payment = await this.processor.check(paymentId);
    if (!payment) this.logger.warn({ paymentId }, 'LigdiCash callback for an unknown payment');
    return { ok: true };
  }
}
