-- CreateEnum
CREATE TYPE "SubmissionVersionState" AS ENUM ('COMPILING', 'READY', 'FAILED');

-- DropForeignKey
ALTER TABLE "Submission" DROP CONSTRAINT "Submission_versionId_fkey";

-- AlterTable
ALTER TABLE "Compilation" ADD COLUMN     "submissionVersionId" TEXT;

-- AlterTable
ALTER TABLE "Submission" DROP COLUMN "previousSubmissionId",
DROP COLUMN "versionId",
ADD COLUMN     "title" TEXT,
ADD COLUMN     "unlockedAt" TIMESTAMP(3),
ADD COLUMN     "unlockedById" TEXT,
ADD COLUMN     "validatedNumber" INTEGER;

-- CreateTable
CREATE TABLE "SubmissionVersion" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "number" INTEGER,
    "projectVersionId" TEXT NOT NULL,
    "filePaths" TEXT[],
    "message" TEXT,
    "files" JSONB NOT NULL,
    "sentById" TEXT NOT NULL,
    "sentIp" TEXT,
    "state" "SubmissionVersionState" NOT NULL DEFAULT 'COMPILING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt" TIMESTAMP(3),

    CONSTRAINT "SubmissionVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SubmissionVersion_submissionId_createdAt_idx" ON "SubmissionVersion"("submissionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SubmissionVersion_submissionId_number_key" ON "SubmissionVersion"("submissionId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Compilation_submissionVersionId_key" ON "Compilation"("submissionVersionId");

-- AddForeignKey
ALTER TABLE "SubmissionVersion" ADD CONSTRAINT "SubmissionVersion_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionVersion" ADD CONSTRAINT "SubmissionVersion_projectVersionId_fkey" FOREIGN KEY ("projectVersionId") REFERENCES "ProjectVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionVersion" ADD CONSTRAINT "SubmissionVersion_sentById_fkey" FOREIGN KEY ("sentById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Compilation" ADD CONSTRAINT "Compilation_submissionVersionId_fkey" FOREIGN KEY ("submissionVersionId") REFERENCES "SubmissionVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- One sending being compiled per submission at most (docs/spec.md, "Encadrement"): a second
-- sending at the same time is refused by this index.
CREATE UNIQUE INDEX "SubmissionVersion_one_compiling" ON "SubmissionVersion"("submissionId")
  WHERE "state" = 'COMPILING';
