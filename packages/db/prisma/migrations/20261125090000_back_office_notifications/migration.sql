-- Step 14: back-office (plan versions, manual credits and refunds, BUSINESS pilot trials) and
-- notifications (e-mail preferences, SMS and e-mail delivery state).

-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('SUPERVISION', 'BILLING', 'QUOTA', 'ORGANIZATION', 'PRINT');

-- AlterEnum
ALTER TYPE "CreditReason" ADD VALUE 'ADMIN_CREDIT';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "businessTrialUsedAt" TIMESTAMP(3),
ADD COLUMN     "emailNotifications" "NotificationCategory"[] DEFAULT ARRAY[]::"NotificationCategory"[];

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "pendingPlanRevisionId" TEXT,
ADD COLUMN     "planRevisionId" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "refundedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "CreditEntry" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "reference" TEXT;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "pilotTrialStartedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "failedAt" TIMESTAMP(3),
ADD COLUMN     "skipped" TEXT;

-- CreateTable
CREATE TABLE "PlanRevision" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "terms" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "changedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlanRevision_planId_version_key" ON "PlanRevision"("planId", "version");

-- CreateIndex
CREATE INDEX "Notification_userId_channel_createdAt_idx" ON "Notification"("userId", "channel", "createdAt");

-- AddForeignKey
ALTER TABLE "PlanRevision" ADD CONSTRAINT "PlanRevision_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanRevision" ADD CONSTRAINT "PlanRevision_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_pendingPlanId_fkey" FOREIGN KEY ("pendingPlanId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planRevisionId_fkey" FOREIGN KEY ("planRevisionId") REFERENCES "PlanRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_pendingPlanRevisionId_fkey" FOREIGN KEY ("pendingPlanRevisionId") REFERENCES "PlanRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditEntry" ADD CONSTRAINT "CreditEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Plan versions are append-only, like the audit log: a change is a new version.
CREATE TRIGGER "PlanRevision_append_only" BEFORE UPDATE OR DELETE OR TRUNCATE ON "PlanRevision"
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Version 1 of every plan: its values before the back-office existed.
INSERT INTO "PlanRevision" ("id", "planId", "version", "terms", "reason")
SELECT 'rev1_' || p."id", p."id", 1, jsonb_build_object(
    'nameFr', p."nameFr",
    'nameEn', p."nameEn",
    'priceMonthlyXof', p."priceMonthlyXof",
    'priceYearlyXof', p."priceYearlyXof",
    'minSeats', p."minSeats",
    'maxSeats', p."maxSeats",
    'trialDays', p."trialDays",
    'maxProjects', p."maxProjects",
    'maxCollaboratorsPerProject', p."maxCollaboratorsPerProject",
    'maxCompileSeconds', p."maxCompileSeconds",
    'maxCompilesPerHour', p."maxCompilesPerHour",
    'storageBytes', p."storageBytes",
    'historyDays', p."historyDays",
    'autoCompile', p."autoCompile",
    'supervisionDashboard', p."supervisionDashboard",
    'maxSupervisedStudents', p."maxSupervisedStudents",
    'aiRequestsPerDay', p."aiRequestsPerDay",
    'compilePriority', p."compilePriority",
    'maxAdmins', p."maxAdmins"
  ), 'initial'
FROM "Plan" p;

-- Periods already paid (and trials) freeze version 1.
UPDATE "Subscription" SET "planRevisionId" = 'rev1_' || "planId";
UPDATE "Subscription" SET "pendingPlanRevisionId" = 'rev1_' || "pendingPlanId"
  WHERE "pendingPlanId" IS NOT NULL;

-- SMS rows written before the notification queue (steps 11 and 13) are never sent afterwards.
UPDATE "Notification" SET "skipped" = 'legacy'
  WHERE "channel" IN ('SMS', 'EMAIL') AND "sentAt" IS NULL;
