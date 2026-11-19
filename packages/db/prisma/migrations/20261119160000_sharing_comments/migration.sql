-- DropForeignKey
ALTER TABLE "Comment" DROP CONSTRAINT "Comment_fileId_fkey";

-- AlterTable
ALTER TABLE "Comment" ADD COLUMN     "resolvedById" TEXT,
ADD COLUMN     "suggestionDecidedAt" TIMESTAMP(3),
ADD COLUMN     "suggestionDecidedById" TEXT,
ALTER COLUMN "fileId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ShareLink" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "includeSources" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ProjectInvitation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "role" "ProjectRole" NOT NULL,
    "message" TEXT,
    "locale" "Locale" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectInvitation_tokenHash_key" ON "ProjectInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "ProjectInvitation_projectId_status_idx" ON "ProjectInvitation"("projectId", "status");

-- CreateIndex
CREATE INDEX "ShareLink_projectId_revokedAt_idx" ON "ShareLink"("projectId", "revokedAt");

-- AddForeignKey
ALTER TABLE "ProjectInvitation" ADD CONSTRAINT "ProjectInvitation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectInvitation" ADD CONSTRAINT "ProjectInvitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectInvitation" ADD CONSTRAINT "ProjectInvitation_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareLink" ADD CONSTRAINT "ShareLink_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "ProjectFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_suggestionDecidedById_fkey" FOREIGN KEY ("suggestionDecidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- One contact per invitation, a message of 280 characters at most (docs/spec.md, "Partage").
ALTER TABLE "ProjectInvitation" ADD CONSTRAINT "ProjectInvitation_one_contact"
  CHECK (("phone" IS NULL) <> ("email" IS NULL));
ALTER TABLE "ProjectInvitation" ADD CONSTRAINT "ProjectInvitation_message_length"
  CHECK ("message" IS NULL OR char_length("message") <= 280);

-- At most one pending invitation per contact and project.
CREATE UNIQUE INDEX "ProjectInvitation_pending_phone_key" ON "ProjectInvitation"("projectId", "phone")
  WHERE "status" = 'PENDING' AND "phone" IS NOT NULL;
CREATE UNIQUE INDEX "ProjectInvitation_pending_email_key" ON "ProjectInvitation"("projectId", "email")
  WHERE "status" = 'PENDING' AND "email" IS NOT NULL;
