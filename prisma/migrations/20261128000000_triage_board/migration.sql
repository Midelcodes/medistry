-- CreateTable
CREATE TABLE "TriageResult" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "TriageResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TriageResult_facilityId_createdAt_idx" ON "TriageResult"("facilityId", "createdAt");

-- CreateIndex
CREATE INDEX "TriageResult_patientId_idx" ON "TriageResult"("patientId");
