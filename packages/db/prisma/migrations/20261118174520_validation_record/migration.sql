-- CreateTable
CREATE TABLE "ValidationRecord" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "validatedById" TEXT NOT NULL,
    "validatedAt" TIMESTAMP(3) NOT NULL,
    "files" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ValidationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ValidationRecord_submissionId_key" ON "ValidationRecord"("submissionId");

-- CreateIndex
CREATE INDEX "ValidationRecord_validatedById_validatedAt_idx" ON "ValidationRecord"("validatedById", "validatedAt");

-- AddForeignKey
ALTER TABLE "ValidationRecord" ADD CONSTRAINT "ValidationRecord_validatedById_fkey" FOREIGN KEY ("validatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The trace of a validation outlives the project and can never be changed (docs/spec.md,
-- "Encadrement"). forbid_mutation() comes from the migration integrity_constraints.
CREATE TRIGGER "ValidationRecord_append_only" BEFORE UPDATE OR DELETE OR TRUNCATE ON "ValidationRecord"
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
