-- CreateEnum
CREATE TYPE "ProxyRelationshipKind" AS ENUM ('parent', 'guardian', 'caregiver', 'spouse', 'other');

-- CreateEnum
CREATE TYPE "ProxyStatus" AS ENUM ('INVITED', 'ACTIVE', 'DECLINED', 'REVOKED', 'ENDED');

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'PROXY';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "displayName" TEXT,
ADD COLUMN     "emailHash" TEXT,
ADD COLUMN     "encryptedEmail" TEXT,
ADD COLUMN     "encryptedPhone" TEXT,
ADD COLUMN     "failedSignIns" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "hasAccount" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastSignInAt" TIMESTAMP(3),
ADD COLUMN     "lockedUntil" TIMESTAMP(3),
ADD COLUMN     "phoneHash" TEXT,
ADD COLUMN     "sessionsNotBefore" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Clinician" ADD COLUMN     "encryptedRejectionReason" TEXT,
ADD COLUMN     "licenceExpiresOn" TEXT,
ADD COLUMN     "licenceReminderSentFor" TEXT,
ADD COLUMN     "registeredAt" TIMESTAMP(3),
ADD COLUMN     "registryMatch" BOOLEAN;

-- CreateTable
CREATE TABLE "ProxyRelationship" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "proxyUserId" TEXT NOT NULL,
    "relationship" "ProxyRelationshipKind" NOT NULL,
    "scopes" TEXT[],
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3),
    "verifiedBy" TEXT,
    "status" "ProxyStatus" NOT NULL,
    "managesMinorAccount" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,

    CONSTRAINT "ProxyRelationship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicianLicenceDocument" (
    "id" TEXT NOT NULL,
    "clinicianId" TEXT NOT NULL,
    "encryptedFilename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "encryptedPayload" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicianLicenceDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProxyRelationship_patientId_idx" ON "ProxyRelationship"("patientId");

-- CreateIndex
CREATE INDEX "ProxyRelationship_proxyUserId_idx" ON "ProxyRelationship"("proxyUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicianLicenceDocument_clinicianId_key" ON "ClinicianLicenceDocument"("clinicianId");

-- CreateIndex
CREATE UNIQUE INDEX "User_phoneHash_key" ON "User"("phoneHash");

-- CreateIndex
CREATE UNIQUE INDEX "User_emailHash_key" ON "User"("emailHash");

-- AddForeignKey
ALTER TABLE "ProxyRelationship" ADD CONSTRAINT "ProxyRelationship_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProxyRelationship" ADD CONSTRAINT "ProxyRelationship_proxyUserId_fkey" FOREIGN KEY ("proxyUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicianLicenceDocument" ADD CONSTRAINT "ClinicianLicenceDocument_clinicianId_fkey" FOREIGN KEY ("clinicianId") REFERENCES "Clinician"("id") ON DELETE CASCADE ON UPDATE CASCADE;

