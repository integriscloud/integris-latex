/** Sends one SMS: the LigdiCash SMS API (sender INTEGRIS), or the log in development. */
export interface SmsSender {
  send(phoneE164: string, text: string): Promise<void>;
}

export const SMS_SENDER = Symbol('SMS_SENDER');

/** A refused SMS; `permanent` when another attempt cannot succeed (number, credentials). */
export class SmsError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
  }
}
