/** Sends one SMS. The LigdiCash SMS API (sender INTEGRIS) will implement this interface later. */
export interface SmsSender {
  send(phoneE164: string, text: string): Promise<void>;
}

export const SMS_SENDER = Symbol('SMS_SENDER');
