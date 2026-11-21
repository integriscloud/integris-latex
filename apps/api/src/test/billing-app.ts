import '../load-env.js';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { CanActivate, ExecutionContext, Type } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AuthGuard } from '../auth/auth.guard.js';
import { BillingModule } from '../billing/billing.module.js';
import type {
  Invoice,
  InvoiceRequest,
  InvoiceStatus,
  PaymentProvider,
} from '../billing/payment-provider.js';
import { PAYMENT_PROVIDER, ProviderError } from '../billing/payment-provider.js';
import { OriginGuard } from '../common/origin.guard.js';
import { ApiConfig, ConfigModule } from '../config/api-config.js';
import { configureApp } from '../configure-app.js';
import type { Mail, MailSender } from '../mail/mail-sender.js';
import { MAIL_SENDER } from '../mail/mail-sender.js';
import { MailModule } from '../mail/mail.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PlanLimitsService } from '../projects/plan-limits.service.js';
import { RedisModule } from '../redis/redis.module.js';
import { RedisService } from '../redis/redis.service.js';
import type { SmsSender } from '../sms/sms-sender.js';
import { SMS_SENDER } from '../sms/sms-sender.js';
import { SmsModule } from '../sms/sms.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { StorageService } from '../storage/storage.service.js';
import { testEnv } from './auth-app.js';
import { FakeBillingDb } from './fake-billing-db.js';
import { FakeStorage } from './fake-projects-db.js';
import { TEST_USER_HEADER } from './projects-app.js';

/** LigdiCash as the tests script it: invoices created, statuses set per token. */
export class FakeProvider implements PaymentProvider {
  invoices: InvoiceRequest[] = [];
  statuses = new Map<string, InvoiceStatus>();
  failNextInvoice = false;
  checks = 0;

  async createInvoice(request: InvoiceRequest): Promise<Invoice> {
    if (this.failNextInvoice) {
      this.failNextInvoice = false;
      throw new ProviderError('down');
    }
    this.invoices.push(request);
    const token = `tok_${this.invoices.length}`;
    return { token, url: `https://ligdicash.test/pay/invoice/${token}` };
  }

  async checkStatus(token: string): Promise<InvoiceStatus> {
    this.checks++;
    return (
      this.statuses.get(token) ?? {
        status: 'pending',
        amountXof: null,
        transactionId: null,
        operator: null,
        raw: {},
      }
    );
  }

  /** The payer paid invoice `token` (the amount of its invoice unless given). */
  pay(token: string, amountXof?: number): void {
    const index = Number(token.replace('tok_', '')) - 1;
    this.statuses.set(token, {
      status: 'completed',
      amountXof: amountXof ?? this.invoices[index]!.amountXof,
      transactionId: `LC-${token}`,
      operator: 'ORANGE BF',
      raw: { status: 'completed', operator_name: 'ORANGE BF' },
    });
  }

  refuse(token: string): void {
    this.statuses.set(token, {
      status: 'failed',
      amountXof: null,
      transactionId: null,
      operator: null,
      raw: { status: 'notcompleted' },
    });
  }
}

export class Outbox implements MailSender, SmsSender {
  mails: Mail[] = [];
  sms: { to: string; text: string }[] = [];

  async send(mailOrPhone: Mail | string, text?: string): Promise<void> {
    if (typeof mailOrPhone === 'string') this.sms.push({ to: mailOrPhone, text: text ?? '' });
    else this.mails.push(mailOrPhone);
  }
}

export interface BillingTestApp {
  app: NestExpressApplication;
  db: FakeBillingDb;
  provider: FakeProvider;
  outbox: Outbox;
  storage: FakeStorage;
  reconciled: string[];
}

/**
 * The billing API (and the given modules: organizations) wired as in production, with fakes for
 * the database, LigdiCash and messages.
 */
export async function createBillingTestApp(
  overrides: Record<string, string> = {},
  modules: Type[] = [],
  /** Providers replaced by test doubles (compilation, history: exam papers tests). */
  providers: { token: unknown; value: unknown }[] = [],
): Promise<BillingTestApp> {
  const env = testEnv(overrides);
  const db = new FakeBillingDb();
  const provider = new FakeProvider();
  const outbox = new Outbox();
  const storage = new FakeStorage();
  const reconciled: string[] = [];
  const fakeAuth: CanActivate = {
    canActivate(context: ExecutionContext) {
      const request = context.switchToHttp().getRequest();
      const user = db.tables.user.find((item) => item.id === request.get(TEST_USER_HEADER));
      if (!user) return false;
      request.auth = { user };
      return true;
    },
  };
  const builder = Test.createTestingModule({
    imports: [
      ConfigModule,
      PrismaModule,
      RedisModule,
      StorageModule,
      SmsModule,
      MailModule,
      BillingModule,
      ...modules,
    ],
    providers: [{ provide: APP_GUARD, useClass: OriginGuard }],
  })
    .overrideProvider(ApiConfig)
    .useValue({ env })
    .overrideProvider(PrismaService)
    .useValue(db)
    .overrideProvider(StorageService)
    .useValue(storage)
    .overrideProvider(PAYMENT_PROVIDER)
    .useValue(provider)
    .overrideProvider(MAIL_SENDER)
    .useValue(outbox)
    .overrideProvider(SMS_SENDER)
    .useValue(outbox)
    .overrideProvider(PlanLimitsService)
    .useValue({
      reconcile: async (userId: string) => {
        reconciled.push(userId);
        return [];
      },
      reconcileQuietly: async (userId: string) => {
        reconciled.push(userId);
        return [];
      },
    })
    .overrideGuard(AuthGuard)
    .useValue(fakeAuth);
  for (const { token, value } of providers) {
    builder.overrideProvider(token as Type).useValue(value);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app);
  await app.init();
  await app.get(RedisService).client.flushdb();
  return { app, db, provider, outbox, storage, reconciled };
}
