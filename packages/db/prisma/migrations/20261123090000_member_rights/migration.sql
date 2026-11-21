-- Step 12 rights: members choosing their own group, students asking to become teachers.

-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "teacherRequestedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "membersChooseGroup" BOOLEAN NOT NULL DEFAULT false;

