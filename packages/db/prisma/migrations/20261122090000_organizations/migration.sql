-- Step 12: Team and Business seats, invitations, CSV imports, join requests, groups and supervision.

-- DropIndex
DROP INDEX "Supervision_supervisorId_studentId_organizationId_key";

-- AlterTable
ALTER TABLE "Invitation" ADD COLUMN     "acceptedById" TEXT,
ADD COLUMN     "decidedAt" TIMESTAMP(3),
ADD COLUMN     "displayName" TEXT,
ADD COLUMN     "groupId" TEXT,
ADD COLUMN     "importId" TEXT,
ADD COLUMN     "locale" "Locale" NOT NULL DEFAULT 'fr';

-- AlterTable
ALTER TABLE "OrgGroup" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "joinCode" TEXT;

-- AlterTable
ALTER TABLE "ProjectMember" ADD COLUMN     "viaSupervisionId" TEXT;

-- AlterTable
ALTER TABLE "Seat" ADD COLUMN     "invitationId" TEXT;

-- AlterTable
ALTER TABLE "Supervision" ADD COLUMN     "assignedById" TEXT,
ADD COLUMN     "endedAt" TIMESTAMP(3),
ADD COLUMN     "endedById" TEXT;

-- AlterTable
ALTER TABLE "UserImport" ADD COLUMN     "fileName" TEXT,
ALTER COLUMN "fileKey" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Invitation_organizationId_status_idx" ON "Invitation"("organizationId", "status");

-- CreateIndex
CREATE INDEX "OrgGroup_organizationId_idx" ON "OrgGroup"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_joinCode_key" ON "Organization"("joinCode");

-- CreateIndex
CREATE UNIQUE INDEX "Seat_invitationId_key" ON "Seat"("invitationId");

-- CreateIndex
CREATE INDEX "Supervision_supervisorId_organizationId_status_idx" ON "Supervision"("supervisorId", "organizationId", "status");

-- CreateIndex
CREATE INDEX "Supervision_studentId_status_idx" ON "Supervision"("studentId", "status");

-- CreateIndex
CREATE INDEX "UserImport_organizationId_createdAt_idx" ON "UserImport"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "Seat" ADD CONSTRAINT "Seat_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES "Invitation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "OrgGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_importId_fkey" FOREIGN KEY ("importId") REFERENCES "UserImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_viaSupervisionId_fkey" FOREIGN KEY ("viaSupervisionId") REFERENCES "Supervision"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- One live seat per person and subscription (a released seat keeps its last holder).
CREATE UNIQUE INDEX "Seat_held_by_user_key" ON "Seat"("subscriptionId", "userId")
  WHERE "userId" IS NOT NULL AND "releasedAt" IS NULL;

-- One pending invitation per contact and organization.
CREATE UNIQUE INDEX "Invitation_pending_phone_key" ON "Invitation"("organizationId", "phone")
  WHERE "status" = 'PENDING' AND "phone" IS NOT NULL;
CREATE UNIQUE INDEX "Invitation_pending_email_key" ON "Invitation"("organizationId", "email")
  WHERE "status" = 'PENDING' AND "email" IS NOT NULL;

-- One live supervision link per supervisor, student and organization (ended links are kept).
CREATE UNIQUE INDEX "Supervision_live_pair_key" ON "Supervision"("supervisorId", "studentId", "organizationId")
  WHERE "status" <> 'ENDED';
