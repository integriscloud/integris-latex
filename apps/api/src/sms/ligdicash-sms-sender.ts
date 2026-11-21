import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { ApiConfig } from '../config/api-config.js';
import { SmsError, type SmsSender } from './sms-sender.js';

const TIMEOUT_MS = 15_000;

/** Path of the send endpoint (LIGDICASH_SMS_API_URL holds the base, https://sms.ligdicash.io). */
export const LIGDICASH_SMS_PATH = '/api/send_sms.php';

const answer = z.object({
  success: z.union([z.boolean(), z.number(), z.string()]),
  data: z.object({ message_id: z.string().optional() }).partial().optional(),
  error: z
    .object({ code: z.union([z.number(), z.string()]).optional(), message: z.string().optional() })
    .optional(),
});

/** Error codes of the API that a later attempt cannot fix (credentials, parameters, number). */
const PERMANENT_CODES = new Set(['1002', '1003', '1006']);

/**
 * API SMS of LigdiCash (sms.ligdicash.io): `GET /api/send_sms.php?to=…&text=…` with the
 * credentials of the account, sent as documented both in the `Authorization: Basic` header
 * (base64 of "user:api key") and as the `api_key` and `token` parameters. The sender name
 * (INTEGRIS) is set on the LigdiCash account. Numbers are sent without the "+".
 */
@Injectable()
export class LigdicashSmsSender implements SmsSender {
  private readonly logger = new Logger('SMS');

  constructor(private readonly config: ApiConfig) {}

  async send(phoneE164: string, text: string): Promise<void> {
    const env = this.config.env;
    const url = new URL(LIGDICASH_SMS_PATH, env.LIGDICASH_SMS_API_URL);
    url.searchParams.set('api_key', env.LIGDICASH_SMS_API_KEY ?? '');
    url.searchParams.set('token', env.LIGDICASH_SMS_TOKEN ?? '');
    url.searchParams.set('to', phoneE164.replace(/^\+/, ''));
    url.searchParams.set('text', text);
    const basic = Buffer.from(`${env.LIGDICASH_SMS_USER}:${env.LIGDICASH_SMS_API_KEY}`).toString(
      'base64',
    );
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/json', Authorization: `Basic ${basic}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (error) {
      throw new SmsError(`network: ${(error as Error).message}`, false);
    }
    const body = await response.text();
    let parsed: z.infer<typeof answer> | null = null;
    try {
      parsed = answer.parse(JSON.parse(body));
    } catch {
      parsed = null;
    }
    if (!parsed) {
      // Accepted but unreadable: never sent again (a duplicate SMS is worse than a lost one).
      if (response.ok) {
        this.logger.warn({ status: response.status }, 'Unreadable answer of the SMS API');
        return;
      }
      throw new SmsError(`http ${response.status}`, response.status < 500);
    }
    const success = parsed.success;
    if (success === true || success === 100 || success === '100') return;
    const code = String(parsed.error?.code ?? '');
    throw new SmsError(
      `ligdicash ${code} ${parsed.error?.message ?? ''}`.trim(),
      PERMANENT_CODES.has(code),
    );
  }
}
