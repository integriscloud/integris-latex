import { Global, Module } from '@nestjs/common';
import { LogSmsSender } from './log-sms-sender.js';
import { SMS_SENDER } from './sms-sender.js';

// SMS_PROVIDER only accepts `log` for now; the real provider is selected here when it exists.
@Global()
@Module({ providers: [{ provide: SMS_SENDER, useClass: LogSmsSender }], exports: [SMS_SENDER] })
export class SmsModule {}
