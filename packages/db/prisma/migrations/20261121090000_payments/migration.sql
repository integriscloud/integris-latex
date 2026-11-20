-- Step 11: LigdiCash payments, credit balance, receipt numbering, trials and pending changes.

-- CreateEnum
CREATE TYPE "CreditReason" AS ENUM ('DUPLICATE_PAYMENT', 'MIN_AMOUNT_TOPUP', 'PRORATION_SURPLUS', 'USED', 'RELEASED', 'REFUNDED');

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "checkoutUrl" TEXT,
ADD COLUMN     "creditUsedXof" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "duplicateReason" TEXT,
ADD COLUMN     "lastCheckedAt" TIMESTAMP(3),
ADD COLUMN     "locale" "Locale" NOT NULL DEFAULT 'fr',
ADD COLUMN     "order" JSONB NOT NULL,
ADD COLUMN     "promoCodeId" TEXT;

-- AlterTable
ALTER TABLE "PromoRedemption" ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "paidFromAt" TIMESTAMP(3),
ADD COLUMN     "paidValueXof" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pendingBillingPeriod" "BillingPeriod",
ADD COLUMN     "pendingSeatCount" INTEGER,
ADD COLUMN     "pendingValueXof" INTEGER;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "trialUsedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CreditEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amountXof" INTEGER NOT NULL,
    "reason" "CreditReason" NOT NULL,
    "paymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingCounter" (
    "id" TEXT NOT NULL,
    "value" INTEGER NOT NULL,

    CONSTRAINT "BillingCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreditEntry_userId_idx" ON "CreditEntry"("userId");

-- CreateIndex
CREATE INDEX "CreditEntry_paymentId_idx" ON "CreditEntry"("paymentId");

-- CreateIndex
CREATE INDEX "Payment_status_createdAt_idx" ON "Payment"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PromoRedemption_promoCodeId_userId_key" ON "PromoRedemption"("promoCodeId", "userId");

-- AddForeignKey
ALTER TABLE "PromoRedemption" ADD CONSTRAINT "PromoRedemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditEntry" ADD CONSTRAINT "CreditEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditEntry" ADD CONSTRAINT "CreditEntry_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Billing invariants (see migration integrity_constraints).
ALTER TABLE "CreditEntry" ADD CONSTRAINT "CreditEntry_amount_nonzero" CHECK ("amountXof" <> 0);
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_creditUsed_nonnegative" CHECK ("creditUsedXof" >= 0);
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_paidValue_nonnegative" CHECK ("paidValueXof" >= 0);
ALTER TABLE "BillingCounter" ADD CONSTRAINT "BillingCounter_value_nonnegative" CHECK ("value" >= 0);

-- Receipt numbers: continuous, without gaps (incremented in the transaction of the receipt).
INSERT INTO "BillingCounter" ("id", "value") VALUES ('receipt', 0);

-- The credit ledger is append-only, like the audit log: a balance is only changed by a new entry.
CREATE TRIGGER "CreditEntry_append_only" BEFORE UPDATE OR DELETE OR TRUNCATE ON "CreditEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
