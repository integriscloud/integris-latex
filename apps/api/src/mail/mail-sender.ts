export interface MailAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
  /** Files sent with the e-mail (receipt PDFs). */
  attachments?: MailAttachment[];
}

/** Sends one e-mail. The Integris SMTP transport will implement this interface later. */
export interface MailSender {
  send(mail: Mail): Promise<void>;
}

export const MAIL_SENDER = Symbol('MAIL_SENDER');
