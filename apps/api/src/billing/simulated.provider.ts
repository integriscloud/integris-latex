import { API_PREFIX, PORTS, type SimulatedInvoice } from '@integris/shared';
import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ApiConfig } from '../config/api-config.js';
import { RedisService } from '../redis/redis.service.js';
import type {
  Invoice,
  InvoiceRequest,
  InvoiceStatus,
  PaymentProvider,
} from './payment-provider.js';

/** Path of the LigdiCash callback, under the API prefix. */
export const LIGDICASH_CALLBACK_PATH = 'payments/ligdicash/callback';

interface StoredInvoice extends SimulatedInvoice {
  paymentId: string;
  status: 'completed' | 'pending' | 'notcompleted';
}

const invoiceKey = (token: string) => `dev:pay:${token}`;
const TTL_SECONDS = 7 * 86_400;

/**
 * Development stand-in for LigdiCash (PAYMENT_PROVIDER=simulated, refused in production): the
 * payer is sent to a local page (/<locale>/dev/pay/<token>) that chooses the outcome, which then
 * calls the real callback endpoint with a LigdiCash-shaped body, twice (JSON then form) as
 * LigdiCash does. The status check reads the chosen outcome, so the whole verification path of
 * the API runs as with LigdiCash.
 */
@Injectable()
export class SimulatedProvider implements PaymentProvider {
  private readonly logger = new Logger('SimulatedLigdiCash');

  constructor(
    private readonly redis: RedisService,
    private readonly config: ApiConfig,
  ) {
    if (config.env.NODE_ENV === 'production') throw new Error('Simulated payments in production');
  }

  async createInvoice(request: InvoiceRequest): Promise<Invoice> {
    const token = `sim_${randomBytes(18).toString('base64url')}`;
    const stored: StoredInvoice = {
      token,
      paymentId: request.paymentId,
      amountXof: request.amountXof,
      description: request.description,
      returnUrl: request.returnUrl,
      cancelUrl: request.cancelUrl,
      status: 'pending',
    };
    await this.redis.client.set(invoiceKey(token), JSON.stringify(stored), 'EX', TTL_SECONDS);
    // Same locale as the return page: /<locale>/app/billing/payments/<id>.
    const locale = new URL(request.returnUrl).pathname.split('/')[1] || 'fr';
    const url = `${this.config.env.PUBLIC_WEB_URL}/${locale}/dev/pay/${token}`;
    this.logger.log(`[simulated LigdiCash] invoice ${token} for payment ${request.paymentId}`);
    return { token, url };
  }

  async checkStatus(token: string): Promise<InvoiceStatus> {
    const stored = await this.read(token);
    const status = stored?.status ?? 'notcompleted';
    return {
      status: status === 'notcompleted' ? 'failed' : status,
      amountXof: stored?.amountXof ?? null,
      transactionId: status === 'completed' ? `SIM-${token.slice(4, 16)}` : null,
      operator: status === 'completed' ? 'SIMULATION' : null,
      raw: { simulated: true, status },
    };
  }

  async read(token: string): Promise<StoredInvoice | null> {
    if (!/^sim_[A-Za-z0-9_-]{10,40}$/.test(token)) return null;
    const value = await this.redis.client.get(invoiceKey(token));
    return value ? (JSON.parse(value) as StoredInvoice) : null;
  }

  /** Sets the outcome and calls the callback endpoint of this API process like LigdiCash. */
  async settle(token: string, outcome: StoredInvoice['status']): Promise<StoredInvoice | null> {
    const stored = await this.read(token);
    if (!stored) return null;
    const settled = { ...stored, status: outcome };
    await this.redis.client.set(invoiceKey(token), JSON.stringify(settled), 'EX', TTL_SECONDS);
    if (outcome !== 'pending') await this.callBack(settled);
    return settled;
  }

  /** The two callbacks of LigdiCash for one payment: JSON, then form-urlencoded. */
  async callBack(invoice: StoredInvoice): Promise<void> {
    // latex-dev cannot reach its own public address: the local API port is called instead.
    const url = `http://127.0.0.1:${PORTS.api}/${API_PREFIX}/${LIGDICASH_CALLBACK_PATH}`;
    const fields = {
      status: invoice.status,
      amount: invoice.amountXof,
      montant: invoice.amountXof,
      token: '',
      external_id: invoice.paymentId,
      operator_name: 'SIMULATION',
    };
    const customData = [
      { keyof_customdata: 'transaction_id', valueof_customdata: invoice.paymentId },
      { keyof_customdata: 'hash', valueof_customdata: 'simulated' },
    ];
    const form = new URLSearchParams(
      Object.entries(fields).map(([key, value]): [string, string] => [key, String(value)]),
    );
    customData.forEach((entry, index) => {
      form.set(`custom_data[${index}][keyof_customdata]`, entry.keyof_customdata);
      form.set(`custom_data[${index}][valueof_customdata]`, entry.valueof_customdata);
    });
    for (const request of [
      { type: 'application/json', body: JSON.stringify({ ...fields, custom_data: customData }) },
      { type: 'application/x-www-form-urlencoded', body: form.toString() },
    ]) {
      try {
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': request.type },
          body: request.body,
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        this.logger.warn({ err: error }, 'Simulated callback failed');
      }
    }
  }
}
