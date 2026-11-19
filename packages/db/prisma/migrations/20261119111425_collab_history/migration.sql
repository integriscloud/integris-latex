-- AlterTable
ALTER TABLE "ProjectVersion" ADD COLUMN     "fileCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "restoreOfId" TEXT,
ADD COLUMN     "restorePath" TEXT;

-- CreateTable
CREATE TABLE "FileDocument" (
    "fileId" TEXT NOT NULL,
    "state" BYTEA NOT NULL,
    "syncedKey" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FileDocument_pkey" PRIMARY KEY ("fileId")
);

-- AddForeignKey
ALTER TABLE "FileDocument" ADD CONSTRAINT "FileDocument_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "ProjectFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
