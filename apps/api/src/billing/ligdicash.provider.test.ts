import { afterEach, describe, expect, it, vi } from 'vitest';
import { testEnv } from '../test/auth-app.js';
import { LigdicashProvider } from './ligdicash.provider.js';
import { ProviderError } from './payment-provider.js';

// The requests sent to LigdiCash, checked against developers.ligdicash.com ("Créer une facture",
// "Vérifier le statut", "Pièges courants"): no real call is made.

const provider = () =>
  new LigdicashProvider({
    env: testEnv({ LIGDICASH_API_URL: 'https://app.ligdicash.com' }),
  } as never);

function answer(body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const request = {
  paymentId: 'cmpay0000000000000000001',
  amountXof: 20000,
  description: 'Integris LaTeX · Abonnement STANDARD · annuel',
  customer: { firstName: 'Awa', lastName: 'Kaboré', email: 'awa@integris.test' },
  returnUrl: 'https://test-latex.integriscloud.com/fr/app/billing/payments/x',
  cancelUrl: 'https://test-latex.integriscloud.com/fr/app/billing/payments/x?canceled=1',
  callbackUrl: 'https://test-latex.integriscloud.com/api/payments/ligdicash/callback',
};

describe('LigdiCash payin with redirection', () => {
  it('creates the invoice at /pay/v01 with the documented headers and body', async () => {
    const fetchMock = answer({
      response_code: '00',
      token: 'tok',
      response_text: 'https://app.ligdicash.com/pay/invoice/tok',
    });
    expect(await provider().createInvoice(request)).toEqual({
      token: 'tok',
      url: 'https://app.ligdicash.com/pay/invoice/tok',
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://app.ligdicash.com/pay/v01/redirect/checkout-invoice/create');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Apikey: 'test-ligdicash-key',
      Authorization: 'Bearer test-ligdicash-token',
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    const { commande } = JSON.parse(init.body as string);
    expect(commande.invoice).toMatchObject({
      total_amount: 20000,
      devise: 'XOF',
      customer: '',
      otp: '',
      external_id: '',
    });
    expect(commande.invoice.items[0]).toMatchObject({
      quantity: 1,
      unit_price: 20000,
      total_price: 20000,
    });
    expect(commande.actions).toEqual({
      cancel_url: request.cancelUrl,
      return_url: request.returnUrl,
      callback_url: request.callbackUrl,
    });
    expect(commande.custom_data).toEqual({ transaction_id: request.paymentId });
  });

  it('refuses an error answer or a payment page outside LigdiCash', async () => {
    answer({ response_code: '01', token: '', response_text: 'Echec (Code02)' });
    await expect(provider().createInvoice(request)).rejects.toBeInstanceOf(ProviderError);
    answer({ response_code: '00', token: 'tok', response_text: 'https://evil.test/pay' });
    await expect(provider().createInvoice(request)).rejects.toBeInstanceOf(ProviderError);
  });

  it('reads the status with the creation token, without Content-Type on GET', async () => {
    const fetchMock = answer({
      response_code: '00',
      status: 'completed',
      amount: 20000,
      montant: 20000,
      operator_name: 'MOOV CI',
      request_id: 'P2771491712026',
      token: '',
    });
    expect(await provider().checkStatus('tok/1')).toMatchObject({
      status: 'completed',
      amountXof: 20000,
      transactionId: 'P2771491712026',
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://app.ligdicash.com/pay/v01/redirect/checkout-invoice/confirm/?invoiceToken=tok%2F1',
    );
    expect(init.headers).not.toHaveProperty('Content-Type');
  });

  it('maps notcompleted to a failure, and a technical or unknown answer to a retry', async () => {
    answer({ response_code: '00', status: 'notcompleted', amount: 20000, montant: 20000 });
    expect((await provider().checkStatus('tok')).status).toBe('failed');
    answer({ response_code: '01', status: '', amount: 0, response_text: 'Echec (Code01)' });
    await expect(provider().checkStatus('tok')).rejects.toBeInstanceOf(ProviderError);
    answer({ response_code: '00', status: 'surprise', amount: 20000 });
    await expect(provider().checkStatus('tok')).rejects.toBeInstanceOf(ProviderError);
  });
});
