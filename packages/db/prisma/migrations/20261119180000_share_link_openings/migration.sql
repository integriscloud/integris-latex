-- CreateTable
CREATE TABLE "ShareLinkOpening" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "firstAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShareLinkOpening_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShareLinkOpening_linkId_ip_hour_key" ON "ShareLinkOpening"("linkId", "ip", "hour");

-- AddForeignKey
ALTER TABLE "ShareLinkOpening" ADD CONSTRAINT "ShareLinkOpening_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "ShareLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

