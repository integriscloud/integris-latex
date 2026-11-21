-- Step 13: exam papers and secretariat (print sends, one-time print links, journal of the exam paper,
-- secretariat groups of invitations, official templates).

-- CreateEnum
CREATE TYPE "PrintSendStatus" AS ENUM ('COMPILING', 'FAILED', 'DONE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PrintEventType" ADD VALUE 'COEDITOR_ADDED';
ALTER TYPE "PrintEventType" ADD VALUE 'COEDITOR_REMOVED';

-- AlterEnum
ALTER TYPE "VersionKind" ADD VALUE 'PRINT';

-- DropForeignKey
ALTER TABLE "PrintRequest" DROP CONSTRAINT "PrintRequest_projectId_fkey";

-- AlterTable
ALTER TABLE "Compilation" ADD COLUMN     "printSendId" TEXT;

-- AlterTable
ALTER TABLE "Invitation" ADD COLUMN     "scopeGroupIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "PrintEvent" ADD COLUMN     "organizationId" TEXT,
ADD COLUMN     "projectId" TEXT,
ALTER COLUMN "printRequestId" DROP NOT NULL,
ALTER COLUMN "actorId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "PrintRequest" ADD COLUMN     "canceledAt" TIMESTAMP(3),
ADD COLUMN     "handedOverAt" TIMESTAMP(3),
ADD COLUMN     "openedAt" TIMESTAMP(3),
ADD COLUMN     "organizationId" TEXT NOT NULL,
ADD COLUMN     "printedAt" TIMESTAMP(3),
ALTER COLUMN "projectId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Template" ADD COLUMN     "createdById" TEXT;

-- CreateTable
CREATE TABLE "PrintSend" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "replacesId" TEXT,
    "versionId" TEXT,
    "status" "PrintSendStatus" NOT NULL DEFAULT 'COMPILING',
    "errors" JSONB,
    "printRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrintSend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrintDownloadLink" (
    "id" TEXT NOT NULL,
    "printRequestId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrintDownloadLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PrintSend_printRequestId_key" ON "PrintSend"("printRequestId");

-- CreateIndex
CREATE INDEX "PrintSend_projectId_createdAt_idx" ON "PrintSend"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "PrintDownloadLink_printRequestId_idx" ON "PrintDownloadLink"("printRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "Compilation_printSendId_key" ON "Compilation"("printSendId");

-- CreateIndex
CREATE INDEX "PrintEvent_projectId_createdAt_idx" ON "PrintEvent"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "PrintEvent_organizationId_createdAt_idx" ON "PrintEvent"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "PrintRequest_organizationId_createdAt_idx" ON "PrintRequest"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "PrintRequest_projectId_idx" ON "PrintRequest"("projectId");

-- AddForeignKey
ALTER TABLE "Compilation" ADD CONSTRAINT "Compilation_printSendId_fkey" FOREIGN KEY ("printSendId") REFERENCES "PrintSend"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintRequest" ADD CONSTRAINT "PrintRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintRequest" ADD CONSTRAINT "PrintRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintSend" ADD CONSTRAINT "PrintSend_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintSend" ADD CONSTRAINT "PrintSend_printRequestId_fkey" FOREIGN KEY ("printRequestId") REFERENCES "PrintRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintDownloadLink" ADD CONSTRAINT "PrintDownloadLink_printRequestId_fkey" FOREIGN KEY ("printRequestId") REFERENCES "PrintRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

