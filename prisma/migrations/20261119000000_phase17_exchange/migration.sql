-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'PHARMACIST';

-- AlterEnum
ALTER TYPE "RecordSource" ADD VALUE 'PHARMACY';

-- AlterEnum
ALTER TYPE "FHIRResourceType" ADD VALUE 'MedicationDispense';

-- AlterTable
ALTER TABLE "Facility" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'HOSPITAL';

-- AlterTable
ALTER TABLE "PatientRecord" ADD COLUMN     "orderingClinicianId" TEXT;

-- CreateTable
CREATE TABLE "OutboxMessage" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,
    "lastError" TEXT,
    "remoteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "OutboxMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutboxMessage_status_nextAttemptAt_idx" ON "OutboxMessage"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "OutboxMessage_facilityId_idx" ON "OutboxMessage"("facilityId");

