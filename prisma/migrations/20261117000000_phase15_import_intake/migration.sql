-- AlterEnum
ALTER TYPE "RecordStatus" ADD VALUE 'DISCARDED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RecordSource" ADD VALUE 'EMR_IMPORT';
ALTER TYPE "RecordSource" ADD VALUE 'AI_DRAFT';

-- AlterTable
ALTER TABLE "PatientRecord" ADD COLUMN     "externalKey" TEXT;

-- CreateTable
CREATE TABLE "FacilityApiClient" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "status" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "FacilityApiClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FacilityPatientLink" (
    "valueHash" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "system" TEXT NOT NULL,
    "encryptedValue" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FacilityPatientLink_pkey" PRIMARY KEY ("valueHash")
);

-- CreateTable
CREATE TABLE "IntakeSession" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "clinicianId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ocrAdapter" TEXT,
    "sttAdapter" TEXT,
    "llmAdapter" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "encryptedSourceText" TEXT NOT NULL,
    "encryptedFile" TEXT,
    "fileMimeType" TEXT,
    "fileSha256" TEXT,
    "encryptedProposals" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntakeSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FacilityApiClient_clientId_key" ON "FacilityApiClient"("clientId");

-- CreateIndex
CREATE INDEX "FacilityPatientLink_facilityId_patientId_idx" ON "FacilityPatientLink"("facilityId", "patientId");

-- CreateIndex
CREATE INDEX "IntakeSession_patientId_idx" ON "IntakeSession"("patientId");

-- CreateIndex
CREATE INDEX "PatientRecord_externalKey_idx" ON "PatientRecord"("externalKey");

-- AddForeignKey
ALTER TABLE "FacilityApiClient" ADD CONSTRAINT "FacilityApiClient_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FacilityPatientLink" ADD CONSTRAINT "FacilityPatientLink_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeSession" ADD CONSTRAINT "IntakeSession_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

