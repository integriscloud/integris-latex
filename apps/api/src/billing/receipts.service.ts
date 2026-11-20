import type { Locale, Payment, Prisma, Receipt } from '@integris/db';
import { RECEIPTS_BUCKET, receiptKey, vatOf } from '@integris/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import { ApiConfig } from '../config/api-config.js';
import { MAIL_SENDER, type MailSender } from '../mail/mail-sender.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import {
  formatDate,
  formatPercent,
  formatXof,
  receiptLabels,
  receiptMail,
  receiptNumber,
} from './billing-messages.js';

/** Price lines of a payment (`Payment.breakdown`). */
export interface Breakdown {
  base: number;
  volumeDiscount: number;
  promo: number;
  promoCode: string | null;
  promoPercent: number | null;
  prorationCredit: number;
  subtotal: number;
  prorationSurplus: number;
  creditUsed: number;
  minimumTopUp: number;
  total: number;
  minAmount: number;
  periodStart: string;
  periodEnd: string;
  /** VAT rate when the payment was created (VAT_RATE_PERCENT); absent before it existed (0). */
  vatRatePercent?: number;
}

/** Who paid, as printed on the receipt (`Receipt.billedTo`). */
export interface BilledTo {
  name: string;
  email: string | null;
  organization: string | null;
  ifu: string | null;
}

const FONT = readFileSync(new URL('../../assets/fonts/PlusJakartaSans.ttf', import.meta.url));

type ReceiptWithPayment = Receipt & {
  payment: Payment & { subscription: { plan: { nameFr: string; nameEn: string } } | null };
};

/**
 * Receipts: one per payment (0 FCFA and credited duplicates included), numbered without gaps,
 * rendered as PDF and sent by e-mail only (docs/spec.md, "Reçus"). Amounts are TTC; no VAT line
 * until the accountant of Integris confirms the rate (docs/spec.md, "Points ouverts").
 */
@Injectable()
export class ReceiptsService {
  private readonly logger = new Logger(ReceiptsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: ApiConfig,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
  ) {}

  /**
   * Gives the payment its receipt, inside the transaction that settles it: the number comes from
   * a counter row incremented in that transaction, so a rolled back payment leaves no gap.
   */
  static async issue(
    tx: Prisma.TransactionClient,
    payment: Payment,
    billedTo: BilledTo,
  ): Promise<Receipt> {
    const counter = await tx.billingCounter.update({
      where: { id: 'receipt' },
      data: { value: { increment: 1 } },
    });
    const receipt = await tx.receipt.create({
      data: {
        number: counter.value,
        paymentId: payment.id,
        billedTo: billedTo as unknown as Prisma.InputJsonValue,
        pdfKey: receiptKey(counter.value),
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: null,
        action: 'RECEIPT_ISSUED',
        targetType: 'Payment',
        targetId: payment.id,
        metadata: { number: counter.value },
      },
    });
    return receipt;
  }

  /** Renders, stores and e-mails a receipt. False when it could not be sent (retried later). */
  async deliver(receiptId: string, options: { resend?: boolean } = {}): Promise<boolean> {
    const db = this.prisma.client;
    const receipt = (await db.receipt.findUnique({
      where: { id: receiptId },
      include: { payment: { include: { subscription: { include: { plan: true } } } } },
    })) as ReceiptWithPayment | null;
    if (!receipt || (receipt.emailedAt && !options.resend)) return false;
    // Sent to the payer's current verified address (the PDF keeps the address of the payment).
    const payer = await db.user.findUnique({ where: { id: receipt.payment.userId } });
    const to = payer?.emailVerifiedAt ? payer.email : null;
    if (!to) {
      this.logger.warn({ receiptId }, 'Receipt without verified e-mail address');
      return false;
    }
    // One sender only (after the payment, or the scheduler): the sending is claimed first.
    if (!options.resend) {
      const claimed = await db.receipt.updateMany({
        where: { id: receipt.id, emailedAt: null },
        data: { emailedAt: new Date() },
      });
      if (!claimed.count) return false;
    }
    try {
      const pdf = await this.render(receipt);
      await this.storage.put(RECEIPTS_BUCKET, receipt.pdfKey, pdf);
      const locale = receipt.payment.locale;
      const breakdown = receipt.payment.breakdown as unknown as Breakdown;
      const credited =
        receipt.payment.status === 'CREDITED'
          ? null
          : breakdown.minimumTopUp + breakdown.prorationSurplus || null;
      await this.mail.send({
        ...receiptMail[locale](
          to,
          receipt.number,
          formatXof(locale, receipt.payment.amountXof),
          credited ? formatXof(locale, credited) : null,
        ),
        attachments: [
          {
            filename: `integris-latex-${receiptNumber(receipt.number)}.pdf`,
            contentType: 'application/pdf',
            content: pdf,
          },
        ],
      });
      if (options.resend) {
        await db.receipt.update({ where: { id: receipt.id }, data: { emailedAt: new Date() } });
      }
      return true;
    } catch (error) {
      this.logger.error({ err: error, receiptId }, 'Receipt not delivered');
      // Released for the next attempt of the scheduler.
      if (!options.resend) {
        await db.receipt
          .update({ where: { id: receipt.id }, data: { emailedAt: null } })
          .catch(() => undefined);
      }
      return false;
    }
  }

  /** Receipts not sent yet (PDF or e-mail failed after the payment), retried by the scheduler. */
  async deliverPending(now = new Date()): Promise<number> {
    const pending = await this.prisma.client.receipt.findMany({
      where: { emailedAt: null, createdAt: { lte: new Date(now.getTime() - 60_000) } },
      orderBy: { number: 'asc' },
      take: 50,
    });
    let sent = 0;
    for (const receipt of pending) if (await this.deliver(receipt.id)) sent++;
    return sent;
  }

  render(receipt: ReceiptWithPayment): Promise<Uint8Array> {
    const { env } = this.config;
    const payment = receipt.payment;
    const locale: Locale = payment.locale;
    const t = receiptLabels[locale];
    const breakdown = payment.breakdown as unknown as Breakdown;
    const billedTo = receipt.billedTo as unknown as BilledTo;
    const raw = (payment.providerRaw ?? {}) as Record<string, unknown>;
    const xof = (amount: number) => formatXof(locale, amount);
    const number = receiptNumber(receipt.number);
    const planName = receipt.payment.subscription
      ? locale === 'fr'
        ? receipt.payment.subscription.plan.nameFr
        : receipt.payment.subscription.plan.nameEn
      : payment.planCode;

    const doc = new PDFDocument({
      size: 'A4',
      margin: 56,
      compress: env.NODE_ENV !== 'test',
      info: { Title: `${t.title} ${number}`, Author: env.BILLING_COMPANY_NAME ?? 'Integris LaTeX' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<Uint8Array>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });
    doc.registerFont('ui', FONT);
    doc.font('ui');

    const muted = '#4a5550';
    doc.fontSize(20).fillColor('#0f2d22').text('Integris LaTeX');
    doc.fontSize(10).fillColor(muted);
    doc.text(env.BILLING_COMPANY_NAME ?? `${t.companyName}${t.colon}${t.toComplete}`);
    doc.text(env.BILLING_ADDRESS ?? `${t.address}${t.colon}${t.toComplete}`);
    doc.text(
      `${t.rccm}${t.colon}${env.BILLING_RCCM ?? t.toComplete} · ${t.ifu}${t.colon}${env.BILLING_IFU ?? t.toComplete}`,
    );
    if (env.BILLING_SUPPORT_EMAIL) doc.text(env.BILLING_SUPPORT_EMAIL);
    doc.moveDown(1.5);

    doc.fontSize(16).fillColor('#000000').text(`${t.number} ${number}`);
    doc.fontSize(10).fillColor(muted);
    doc.text(`${t.date}${t.colon}${formatDate(payment.verifiedAt ?? receipt.createdAt)}`);
    doc.moveDown();
    doc.fillColor('#000000').text(`${t.billedTo}${t.colon.trimEnd()}`);
    doc.fillColor(muted);
    doc.text(billedTo.name);
    if (billedTo.organization) doc.text(billedTo.organization);
    if (billedTo.ifu) doc.text(`${t.ifu}${t.colon}${billedTo.ifu}`);
    if (billedTo.email) doc.text(billedTo.email);
    doc.moveDown(1.5);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const line = (label: string, amount: string, strong = false) => {
      const y = doc.y;
      doc.fillColor(strong ? '#000000' : '#1c2420').fontSize(strong ? 12 : 10);
      doc.text(label, left, y, { width: width - 140 });
      const after = doc.y;
      doc.text(amount, left + width - 130, y, { width: 130, align: 'right' });
      doc.y = Math.max(after, doc.y) + 4;
    };
    const start = formatDate(new Date(breakdown.periodStart));
    const end = formatDate(new Date(breakdown.periodEnd));
    const description = [
      `${t.purposes[payment.purpose]} ${planName}`,
      t.period[payment.billingPeriod],
      t.seats(payment.seats),
      t.from(start, end),
    ].join(' · ');
    doc.fontSize(10).fillColor('#000000').text(t.description, left, doc.y);
    doc.moveDown(0.5);
    line(description, xof(breakdown.base));
    if (breakdown.promo) {
      line(
        t.promo(breakdown.promoCode ?? '', breakdown.promoPercent ?? 0),
        `−${xof(breakdown.promo)}`,
      );
    }
    if (breakdown.prorationCredit) line(t.proration, `−${xof(breakdown.prorationCredit)}`);
    if (breakdown.creditUsed) line(t.creditUsed, `−${xof(breakdown.creditUsed)}`);
    if (breakdown.minimumTopUp) {
      line(
        t.minimumTopUp(xof(breakdown.minAmount), xof(breakdown.minimumTopUp)),
        `+${xof(breakdown.minimumTopUp)}`,
      );
    }
    if (breakdown.prorationSurplus) line(t.prorationSurplus(xof(breakdown.prorationSurplus)), '');
    doc.moveDown(0.5);
    // Plan prices are TTC: the amount paid is split with the rate kept on the payment.
    const rate = breakdown.vatRatePercent ?? 0;
    const { ht, vat } = vatOf(payment.amountXof, rate);
    line(t.ht, xof(ht));
    line(t.vat(formatPercent(locale, rate)), xof(vat));
    line(t.paid, xof(payment.amountXof), true);
    doc.moveDown();

    doc.fontSize(10).fillColor(muted);
    doc.text(
      `${t.method}${t.colon}${payment.amountXof > 0 ? `${t.methodLigdiCash}${typeof raw.operator_name === 'string' ? ` (${raw.operator_name})` : ''}` : t.methodCredit}`,
      left,
      doc.y,
    );
    if (payment.providerTransactionId) {
      doc.text(`${t.transaction}${t.colon}${payment.providerTransactionId}`);
    }
    if (payment.status === 'CREDITED') {
      doc.moveDown();
      doc.fillColor('#000000').text(t.credited(xof(payment.amountXof + payment.creditUsedXof)));
      doc.text(t.refund(env.BILLING_SUPPORT_EMAIL ?? null, number));
    }
    doc.moveDown();
    doc.fillColor(muted).text(t.ttc);
    doc.end();
    return done;
  }
}
