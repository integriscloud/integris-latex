export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/** Sends one e-mail. The Integris SMTP transport will implement this interface later. */
export interface MailSender {
  send(mail: Mail): Promise<void>;
}

export const MAIL_SENDER = Symbol('MAIL_SENDER');
