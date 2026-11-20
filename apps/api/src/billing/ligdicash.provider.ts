import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { ApiConfig } from '../config/api-config.js';
import {
  type Invoice,
  type InvoiceRequest,
  type InvoiceStatus,
  type PaymentProvider,
  ProviderError,
} from './payment-provider.js';

const TIMEOUT_MS = 20_000;

/** Paths of the LigdiCash API (LIGDICASH_API_URL holds the base only, e.g. https://app.ligdicash.com). */
export const LIGDICASH_PATHS = {
  create: '/pay/v01/redirect/checkout-invoice/create',
  // With the slash before the query string, as in the cURL and Node.js examples of the docs.
  confirm: '/pay/v01/redirect/checkout-invoice/confirm/',
} as const;

const createAnswer = z.object({
  response_code: z.string(),
  token: z.string().optional(),
  response_text: z.string().optional(),
});

const amount = z.union([z.number(), z.string()]).optional().nullable();

const confirmAnswer = z.object({
  response_code: z.string().optional(),
  status: z.string().optional(),
  amount,
  montant: amount,
  operator_name: z.string().optional().nullable(),
  operator_id: z.union([z.string(), z.number()]).optional().nullable(),
  request_id: z.union([z.string(), z.number()]).optional().nullable(),
  oreference: z.union([z.string(), z.number()]).optional().nullable(),
  transaction_id: z.union([z.string(), z.number()]).optional().nullable(),
  date: z.string().optional().nullable(),
  response_text: z.string().optional().nullable(),
});

/** Integer amount from a LigdiCash answer (a number or a string of digits); null otherwise. */
function integer(value: number | string | null | undefined): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'string' && /^\d+(\.0+)?$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

const text = (value: string | number | null | undefined) =>
  value === null || value === undefined || value === '' ? null : String(value);

/** The payer is only ever sent to an https page of LigdiCash (ligdicash.com or a subdomain). */
export function isLigdicashPage(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'ligdicash.com' || parsed.hostname.endsWith('.ligdicash.com'))
    );
  } catch {
    return false;
  }
}

/**
 * LigdiCash API, "payin avec redirection" (developers.ligdicash.com): an invoice is created, the
 * payer is redirected to LigdiCash, and the status is read back with the invoice token. Amounts
 * are integers in XOF.
 */
@Injectable()
export class LigdicashProvider implements PaymentProvider {
  private readonly logger = new Logger(LigdicashProvider.name);
  private readonly baseUrl: string;

  constructor(private readonly config: ApiConfig) {
    this.baseUrl = config.env.LIGDICASH_API_URL.replace(/\/+$/, '');
  }

  /** Apikey, Authorization and Accept on every call; Content-Type on POST only (docs). */
  private headers(post: boolean): Record<string, string> {
    return {
      Apikey: this.config.env.LIGDICASH_API_KEY,
      Authorization: `Bearer ${this.config.env.LIGDICASH_AUTH_TOKEN}`,
      Accept: 'application/json',
      ...(post ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  /** `label` names the call in the logs (the path carries the invoice token). */
  private async call(label: string, path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: this.headers(init.method === 'POST'),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.error({ err: error, call: label }, 'LigdiCash unreachable');
      throw new ProviderError('LigdiCash unreachable');
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok || body === null) {
      this.logger.error({ status: response.status, call: label }, 'LigdiCash error');
      throw new ProviderError(`LigdiCash answered ${response.status}`);
    }
    return body;
  }

  async createInvoice(request: InvoiceRequest): Promise<Invoice> {
    const body = {
      commande: {
        invoice: {
          items: [
            {
              name: request.description,
              description: request.description,
              quantity: 1,
              unit_price: request.amountXof,
              total_price: request.amountXof,
            },
          ],
          total_amount: request.amountXof,
          devise: 'XOF',
          description: request.description,
          // Empty for the redirect flow: a phone number here limits the operators offered.
          customer: '',
          customer_firstname: request.customer.firstName,
          customer_lastname: request.customer.lastName,
          customer_email: request.customer.email,
          external_id: '',
          otp: '',
        },
        store: { name: 'Integris LaTeX', website_url: new URL(request.returnUrl).origin },
        actions: {
          cancel_url: request.cancelUrl,
          return_url: request.returnUrl,
          callback_url: request.callbackUrl,
        },
        custom_data: { transaction_id: request.paymentId },
      },
    };
    const answer = createAnswer.safeParse(
      await this.call('create', LIGDICASH_PATHS.create, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
    if (
      !answer.success ||
      answer.data.response_code !== '00' ||
      !answer.data.token ||
      !isLigdicashPage(answer.data.response_text)
    ) {
      this.logger.error(
        {
          code: answer.success ? answer.data.response_code : 'invalid',
          paymentId: request.paymentId,
        },
        'LigdiCash refused the invoice',
      );
      throw new ProviderError('Invoice refused');
    }
    return { token: answer.data.token, url: answer.data.response_text };
  }

  async checkStatus(token: string): Promise<InvoiceStatus> {
    const parsed = confirmAnswer.safeParse(
      await this.call(
        'confirm',
        `${LIGDICASH_PATHS.confirm}?invoiceToken=${encodeURIComponent(token)}`,
        { method: 'GET' },
      ),
    );
    if (!parsed.success) throw new ProviderError('Unexpected status answer');
    const answer = parsed.data;
    // response_code "01" is a technical error of the call, not a failed payment: checked again
    // later. The payment itself is told by `status` only: completed, pending or notcompleted.
    if (answer.response_code !== '00') throw new ProviderError('Status not available');
    const statuses = {
      completed: 'completed',
      pending: 'pending',
      notcompleted: 'failed',
    } as const;
    const status = statuses[answer.status as keyof typeof statuses];
    if (!status) throw new ProviderError('Unknown payment status');
    return {
      status,
      amountXof: integer(answer.amount) ?? integer(answer.montant),
      transactionId:
        text(answer.transaction_id) ?? text(answer.request_id) ?? text(answer.oreference),
      operator: text(answer.operator_name),
      raw: {
        response_code: answer.response_code ?? null,
        status: answer.status ?? null,
        amount: integer(answer.amount) ?? integer(answer.montant),
        operator_name: text(answer.operator_name),
        operator_id: text(answer.operator_id),
        request_id: text(answer.request_id),
        oreference: text(answer.oreference),
        date: answer.date ?? null,
        response_text: answer.response_text ?? null,
      },
    };
  }
}
