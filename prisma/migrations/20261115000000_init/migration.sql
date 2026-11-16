-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('PATIENT', 'DOCTOR', 'NURSE', 'RECORDS_OFFICER', 'FACILITY_ADMIN', 'PLATFORM_ADMIN');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "AccessType" AS ENUM ('NORMAL_CONSENT', 'EMERGENCY_BREAK_GLASS', 'PRE_SHARED_LINK', 'SYSTEM_ADMIN');

-- CreateEnum
CREATE TYPE "BreakGlassReason" AS ENUM ('UNCONSCIOUS', 'LIFE_THREATENING', 'PATIENT_UNABLE_TO_CONSENT', 'OTHER');

-- CreateEnum
CREATE TYPE "RecordStatus" AS ENUM ('DRAFT', 'FINAL');

-- CreateEnum
CREATE TYPE "RecordSource" AS ENUM ('CLINICIAN', 'PATIENT_REPORTED');

-- CreateEnum
CREATE TYPE "RecordFlagStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "OfflineScanStatus" AS ENUM ('ACCEPTED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "ConsentRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('PENDING_REVIEW', 'UNDER_INVESTIGATION', 'RESOLVED_VALID', 'RESOLVED_BREACH');

-- CreateEnum
CREATE TYPE "BloodGroup" AS ENUM ('A_POSITIVE', 'A_NEGATIVE', 'B_POSITIVE', 'B_NEGATIVE', 'AB_POSITIVE', 'AB_NEGATIVE', 'O_POSITIVE', 'O_NEGATIVE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "Genotype" AS ENUM ('AA', 'AS', 'SS', 'AC', 'SC', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "FHIRResourceType" AS ENUM ('Patient', 'Encounter', 'Condition', 'Observation', 'DiagnosticReport', 'Procedure', 'MedicationRequest', 'MedicationStatement', 'AllergyIntolerance', 'Immunization', 'DocumentReference');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "passwordHash" TEXT,
    "role" "UserRole" NOT NULL,
    "twoFactorSecret" TEXT,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "countryCode" TEXT NOT NULL DEFAULT 'NG',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "userAgent" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Facility" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL DEFAULT 'NG',
    "registryCode" TEXT,
    "registrationNo" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "synthetic" BOOLEAN NOT NULL DEFAULT false,
    "status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Facility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Clinician" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "licenseNumber" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL DEFAULT 'NG',
    "specialty" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "verifiedAt" TIMESTAMP(3),
    "verifiedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Clinician_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicianDeviceKey" (
    "clinicianId" TEXT NOT NULL,
    "thumbprint" TEXT NOT NULL,
    "publicJwk" JSONB NOT NULL,
    "boundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ClinicianDeviceKey_pkey" PRIMARY KEY ("clinicianId","thumbprint")
);

-- CreateTable
CREATE TABLE "ClinicianFacility" (
    "id" TEXT NOT NULL,
    "clinicianId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClinicianFacility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FacilityAdmin" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FacilityAdmin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Patient" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "encryptedFirstName" TEXT NOT NULL,
    "encryptedLastName" TEXT NOT NULL,
    "encryptedDob" TEXT NOT NULL,
    "gender" TEXT NOT NULL,
    "encryptedNin" TEXT,
    "photoUrl" TEXT,
    "bloodGroup" "BloodGroup" NOT NULL DEFAULT 'UNKNOWN',
    "genotype" "Genotype" NOT NULL DEFAULT 'UNKNOWN',
    "advanceDirectiveDnr" BOOLEAN NOT NULL DEFAULT false,
    "organDonor" BOOLEAN NOT NULL DEFAULT false,
    "publicEmergencyOptIn" BOOLEAN NOT NULL DEFAULT false,
    "encryptedEmergencyProfile" TEXT NOT NULL,
    "cardMedicationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cardIncludeRecentDiagnosis" BOOLEAN NOT NULL DEFAULT false,
    "cardVersion" INTEGER NOT NULL DEFAULT 0,
    "cardStale" BOOLEAN NOT NULL DEFAULT false,
    "preferredLocale" TEXT,
    "countryCode" TEXT NOT NULL DEFAULT 'NG',
    "primaryFacilityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Patient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfflineCard" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "kid" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "encryptedCurrentToken" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revocationReason" TEXT,
    "supersededById" TEXT,

    CONSTRAINT "OfflineCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfflineScanEvent" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "cardVersion" INTEGER NOT NULL,
    "cardKid" TEXT NOT NULL,
    "clinicianId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "clinicianCountry" TEXT NOT NULL,
    "cardCountry" TEXT NOT NULL,
    "reason" "BreakGlassReason" NOT NULL,
    "encryptedDetails" TEXT,
    "scannedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "deviceKeyThumbprint" TEXT NOT NULL,
    "deviceSig" TEXT NOT NULL,
    "auditLogId" TEXT NOT NULL,
    "status" "OfflineScanStatus" NOT NULL DEFAULT 'ACCEPTED',

    CONSTRAINT "OfflineScanEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmergencyCode" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "encryptedCode" TEXT NOT NULL,
    "displayCode" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "revokedAt" TIMESTAMP(3),
    "revocationReason" TEXT,
    "reissuedFromId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmergencyCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientRecord" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "resourceType" "FHIRResourceType" NOT NULL,
    "versionId" INTEGER NOT NULL DEFAULT 1,
    "isLatest" BOOLEAN NOT NULL DEFAULT true,
    "previousVersionId" TEXT,
    "status" "RecordStatus" NOT NULL DEFAULT 'FINAL',
    "source" "RecordSource" NOT NULL DEFAULT 'CLINICIAN',
    "draftedByUserId" TEXT,
    "signedByClinicianId" TEXT,
    "signedAt" TIMESTAMP(3),
    "authorClinicianId" TEXT NOT NULL,
    "originFacilityId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL DEFAULT 'NG',
    "clinicalCategory" TEXT,
    "effectiveDate" TEXT NOT NULL,
    "encryptedPayload" TEXT NOT NULL,
    "payloadSignature" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatientRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecordFlag" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "encryptedNote" TEXT NOT NULL,
    "authorClinicianId" TEXT NOT NULL,
    "status" "RecordFlagStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecordFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentRequest" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "requestingClinicianId" TEXT NOT NULL,
    "requestingClinicianName" TEXT NOT NULL,
    "requestingFacilityId" TEXT NOT NULL,
    "requestingFacilityName" TEXT NOT NULL,
    "requestedScopes" TEXT[],
    "durationPreset" TEXT NOT NULL,
    "durationHours" DOUBLE PRECISION NOT NULL,
    "encryptedClinicalReason" TEXT NOT NULL,
    "hashedOtp" TEXT NOT NULL,
    "otpExpiresAt" TIMESTAMP(3) NOT NULL,
    "otpAttemptsRemaining" INTEGER NOT NULL,
    "status" "ConsentRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentGrant" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "targetFacilityId" TEXT,
    "targetClinicianId" TEXT,
    "scopes" TEXT[],
    "requestingClinicianName" TEXT NOT NULL,
    "requestingFacilityName" TEXT NOT NULL,
    "encryptedClinicalReason" TEXT NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "isRevoked" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" TIMESTAMP(3),
    "revocationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsentGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmergencyAccessGrant" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encryptedEmergencyCode" TEXT NOT NULL,
    "clinicianId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "facilityName" TEXT NOT NULL,
    "treatingDoctorName" TEXT NOT NULL,
    "reason" "BreakGlassReason" NOT NULL,
    "encryptedReasonDetails" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "fullHistoryAccess" BOOLEAN NOT NULL DEFAULT false,
    "coSignClinicianId" TEXT,
    "coSignDoctorName" TEXT,
    "encryptedCoSignReason" TEXT,
    "isDisputed" BOOLEAN NOT NULL DEFAULT false,
    "disputeReason" TEXT,

    CONSTRAINT "EmergencyAccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DisputeTicket" (
    "ticketId" TEXT NOT NULL,
    "auditLogId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "facilityId" TEXT,
    "accessType" "AccessType" NOT NULL,
    "encryptedDisputeReason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "adminNotes" TEXT,

    CONSTRAINT "DisputeTicket_pkey" PRIMARY KEY ("ticketId")
);

-- CreateTable
CREATE TABLE "NotificationLog" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "encryptedRecipient" TEXT NOT NULL,
    "encryptedTitle" TEXT,
    "encryptedBody" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "sequenceNumber" INTEGER NOT NULL,
    "timestamp" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "subjectId" TEXT,
    "action" TEXT NOT NULL,
    "accessType" "AccessType" NOT NULL,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "facilityId" TEXT,
    "countryCode" TEXT,
    "ipAddress" TEXT NOT NULL,
    "userAgent" TEXT NOT NULL,
    "encryptedReason" TEXT,
    "previousHash" TEXT NOT NULL,
    "currentHash" TEXT NOT NULL,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Facility_registrationNo_key" ON "Facility"("registrationNo");

-- CreateIndex
CREATE UNIQUE INDEX "Clinician_userId_key" ON "Clinician"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Clinician_licenseNumber_key" ON "Clinician"("licenseNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicianFacility_clinicianId_facilityId_key" ON "ClinicianFacility"("clinicianId", "facilityId");

-- CreateIndex
CREATE UNIQUE INDEX "FacilityAdmin_userId_key" ON "FacilityAdmin"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Patient_userId_key" ON "Patient"("userId");

-- CreateIndex
CREATE INDEX "OfflineCard_patientId_revokedAt_idx" ON "OfflineCard"("patientId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OfflineCard_patientId_version_key" ON "OfflineCard"("patientId", "version");

-- CreateIndex
CREATE INDEX "OfflineScanEvent_patientId_scannedAt_idx" ON "OfflineScanEvent"("patientId", "scannedAt");

-- CreateIndex
CREATE INDEX "OfflineScanEvent_clinicianId_scannedAt_idx" ON "OfflineScanEvent"("clinicianId", "scannedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmergencyCode_codeHash_key" ON "EmergencyCode"("codeHash");

-- CreateIndex
CREATE INDEX "EmergencyCode_patientId_isActive_idx" ON "EmergencyCode"("patientId", "isActive");

-- CreateIndex
CREATE INDEX "PatientRecord_patientId_resourceType_isLatest_idx" ON "PatientRecord"("patientId", "resourceType", "isLatest");

-- CreateIndex
CREATE INDEX "PatientRecord_patientId_status_idx" ON "PatientRecord"("patientId", "status");

-- CreateIndex
CREATE INDEX "RecordFlag_patientId_createdAt_idx" ON "RecordFlag"("patientId", "createdAt");

-- CreateIndex
CREATE INDEX "RecordFlag_authorClinicianId_status_idx" ON "RecordFlag"("authorClinicianId", "status");

-- CreateIndex
CREATE INDEX "ConsentRequest_patientId_status_idx" ON "ConsentRequest"("patientId", "status");

-- CreateIndex
CREATE INDEX "ConsentGrant_patientId_isRevoked_validUntil_idx" ON "ConsentGrant"("patientId", "isRevoked", "validUntil");

-- CreateIndex
CREATE INDEX "EmergencyAccessGrant_patientId_expiresAt_idx" ON "EmergencyAccessGrant"("patientId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "DisputeTicket_auditLogId_key" ON "DisputeTicket"("auditLogId");

-- CreateIndex
CREATE INDEX "NotificationLog_createdAt_idx" ON "NotificationLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_sequenceNumber_key" ON "AuditLog"("sequenceNumber");

-- CreateIndex
CREATE INDEX "AuditLog_subjectId_sequenceNumber_idx" ON "AuditLog"("subjectId", "sequenceNumber");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_sequenceNumber_idx" ON "AuditLog"("actorId", "sequenceNumber");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Clinician" ADD CONSTRAINT "Clinician_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Clinician" ADD CONSTRAINT "Clinician_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicianDeviceKey" ADD CONSTRAINT "ClinicianDeviceKey_clinicianId_fkey" FOREIGN KEY ("clinicianId") REFERENCES "Clinician"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicianFacility" ADD CONSTRAINT "ClinicianFacility_clinicianId_fkey" FOREIGN KEY ("clinicianId") REFERENCES "Clinician"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicianFacility" ADD CONSTRAINT "ClinicianFacility_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FacilityAdmin" ADD CONSTRAINT "FacilityAdmin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FacilityAdmin" ADD CONSTRAINT "FacilityAdmin_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Patient" ADD CONSTRAINT "Patient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfflineCard" ADD CONSTRAINT "OfflineCard_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfflineScanEvent" ADD CONSTRAINT "OfflineScanEvent_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfflineScanEvent" ADD CONSTRAINT "OfflineScanEvent_clinicianId_fkey" FOREIGN KEY ("clinicianId") REFERENCES "Clinician"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyCode" ADD CONSTRAINT "EmergencyCode_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientRecord" ADD CONSTRAINT "PatientRecord_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientRecord" ADD CONSTRAINT "PatientRecord_originFacilityId_fkey" FOREIGN KEY ("originFacilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordFlag" ADD CONSTRAINT "RecordFlag_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "PatientRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentRequest" ADD CONSTRAINT "ConsentRequest_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentGrant" ADD CONSTRAINT "ConsentGrant_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentGrant" ADD CONSTRAINT "ConsentGrant_targetFacilityId_fkey" FOREIGN KEY ("targetFacilityId") REFERENCES "Facility"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyAccessGrant" ADD CONSTRAINT "EmergencyAccessGrant_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyAccessGrant" ADD CONSTRAINT "EmergencyAccessGrant_clinicianId_fkey" FOREIGN KEY ("clinicianId") REFERENCES "Clinician"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyAccessGrant" ADD CONSTRAINT "EmergencyAccessGrant_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyAccessGrant" ADD CONSTRAINT "EmergencyAccessGrant_coSignClinicianId_fkey" FOREIGN KEY ("coSignClinicianId") REFERENCES "Clinician"("id") ON DELETE SET NULL ON UPDATE CASCADE;

