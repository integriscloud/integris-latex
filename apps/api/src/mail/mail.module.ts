import { Global, Module } from '@nestjs/common';
import { LogMailSender } from './log-mail-sender.js';
import { MAIL_SENDER } from './mail-sender.js';

// MAIL_PROVIDER only accepts `log` for now; the SMTP transport is selected here when it exists.
@Global()
@Module({ providers: [{ provide: MAIL_SENDER, useClass: LogMailSender }], exports: [MAIL_SENDER] })
export class MailModule {}
