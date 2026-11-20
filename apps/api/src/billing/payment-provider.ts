/** A LigdiCash invoice ("payin avec redirection") to create for one payment. */
export interface InvoiceRequest {
  /** Our payment id, sent as `custom_data.transaction_id` and read back from the callback. */
  paymentId: string;
  amountXof: number;
  description: string;
  customer: { firstName: string; lastName: string; email: string };
  returnUrl: string;
  cancelUrl: string;
  callbackUrl: string;
}

export interface Invoice {
  /** Invoice token: the only value accepted to check the payment status. */
  token: string;
  /** LigdiCash payment page the payer is sent to. */
  url: string;
}

/** Status of an invoice as the provider's API reports it (never as a callback claims it). */
export interface InvoiceStatus {
  status: 'completed' | 'pending' | 'failed';
  amountXof: number | null;
  /** Provider reference of the transaction (idempotency key), when paid. */
  transactionId: string | null;
  operator: string | null;
  /** Answer kept with the payment, without the customer details. */
  raw: Record<string, unknown>;
}

export interface PaymentProvider {
  createInvoice(request: InvoiceRequest): Promise<Invoice>;
  checkStatus(token: string): Promise<InvoiceStatus>;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

/** The provider could not be reached or refused the request (502 `payment_unavailable`). */
export class ProviderError extends Error {}
