import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { ApiConfig } from '../config/api-config.js';
import type { Mail, MailSender } from './mail-sender.js';

/**
 * The SMTP server of Integris (MAIL_PROVIDER=smtp). TLS is required: implicit on port 465
 * (SMTP_SECURE=true), STARTTLS otherwise; the server certificate is always verified.
 */
@Injectable()
export class SmtpMailSender implements MailSender, OnModuleDestroy {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(config: ApiConfig) {
    const env = config.env;
    this.from = env.SMTP_FROM ?? '';
    this.transport = createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      requireTLS: !env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' } : undefined,
      tls: { rejectUnauthorized: true },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
  }

  async send(mail: Mail): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      attachments: (mail.attachments ?? []).map((file) => ({
        filename: file.filename,
        contentType: file.contentType,
        content: Buffer.from(file.content),
      })),
    });
  }

  onModuleDestroy(): void {
    this.transport.close();
  }
}
