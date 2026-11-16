-- AlterTable
ALTER TABLE "User" ADD COLUMN     "staffFacilityId" TEXT;

-- AlterTable
ALTER TABLE "Patient" ADD COLUMN     "mergedIntoPatientId" TEXT;

-- CreateTable
CREATE TABLE "PatientIdentifier" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "idType" TEXT NOT NULL,
    "blindIndex" TEXT NOT NULL,
    "encryptedValue" TEXT NOT NULL,
    "last2" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "matchScore" DOUBLE PRECISION NOT NULL,
    "verifier" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatientIdentifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DuplicateReview" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "candidatePatientId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "breakdown" JSONB NOT NULL,
    "facilityId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "DuplicateReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientMerge" (
    "id" TEXT NOT NULL,
    "survivorId" TEXT NOT NULL,
    "mergedId" TEXT NOT NULL,
    "reviewId" TEXT,
    "mergedBy" TEXT NOT NULL,
    "mergedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "unmergedBy" TEXT,
    "unmergedAt" TIMESTAMP(3),

    CONSTRAINT "PatientMerge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PatientIdentifier_blindIndex_key" ON "PatientIdentifier"("blindIndex");

-- CreateIndex
CREATE INDEX "PatientIdentifier_patientId_idx" ON "PatientIdentifier"("patientId");

-- CreateIndex
CREATE INDEX "DuplicateReview_status_idx" ON "DuplicateReview"("status");

-- CreateIndex
CREATE INDEX "PatientMerge_survivorId_idx" ON "PatientMerge"("survivorId");

-- AddForeignKey
ALTER TABLE "PatientIdentifier" ADD CONSTRAINT "PatientIdentifier_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

