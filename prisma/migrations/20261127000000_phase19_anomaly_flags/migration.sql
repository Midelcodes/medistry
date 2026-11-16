-- CreateTable
CREATE TABLE "AnomalyFlag" (
    "id" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "clinicianId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "eventRefs" TEXT[],
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "explanation" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "encryptedReviewNote" TEXT,

    CONSTRAINT "AnomalyFlag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AnomalyFlag_dedupeKey_key" ON "AnomalyFlag"("dedupeKey");

-- CreateIndex
CREATE INDEX "AnomalyFlag_status_createdAt_idx" ON "AnomalyFlag"("status", "createdAt");

