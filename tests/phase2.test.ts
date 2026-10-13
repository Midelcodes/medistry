/**
 * Phase 2 Comprehensive Test Suite
 * Tests: Password Hashing, TOTP, Central Policy Engine, MDCN Verification, Audit Hash-Chain Integrity.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  hashPassword,
  verifyPassword,
  generateTotpSecret,
  generateTotp,
  verifyTotp,
  generateSessionToken,
} from '../src/lib/auth/security.ts';

import {
  evaluatePolicy,
  type ActorContext,
  type ConsentContext,
  type EmergencyGrantContext,
} from '../src/lib/policy/enforcer.ts';

import {
  validateMdcnLicenseFormat,
  ClinicianVerificationManager,
  type ClinicianProfile,
} from '../src/lib/clinician/verification.ts';

import {
  AuditChainManager,
  GENESIS_HASH,
} from '../src/lib/audit/hashChain.ts';

describe('1. Security & Authentication Primitives', () => {
  test('Password hashing and verification with scrypt', async () => {
    const password = 'ClinicianSecurePassword2026!';
    const hash = await hashPassword(password);

    assert.ok(hash.startsWith('scrypt$'), 'Hash must start with scrypt scheme identifier');
    
    const isValid = await verifyPassword(password, hash);
    assert.equal(isValid, true, 'Valid password must verify successfully');

    const isInvalid = await verifyPassword('WrongPassword123', hash);
    assert.equal(isInvalid, false, 'Incorrect password must fail verification');

    const malformed = await verifyPassword(password, 'malformed-hash-string');
    assert.equal(malformed, false, 'Malformed hash must safely fail without crashing');
  });

  test('TOTP secret generation, token creation and window verification', () => {
    const secret = generateTotpSecret();
    assert.ok(secret.length >= 20, 'TOTP secret must have sufficient entropy');

    const now = Date.now();
    const token = generateTotp(secret, now);

    assert.match(token, /^\d{6}$/, 'TOTP token must be 6 digits');

    // Valid token passes
    const isValid = verifyTotp(token, secret, now);
    assert.equal(isValid, true, 'Current token must verify');

    // Wrong token fails
    const isWrong = verifyTotp('000000', secret, now);
    assert.equal(isWrong, false, 'Invalid token must fail');

    // Window drift: within 30s passes with default window=1
    const driftedToken = generateTotp(secret, now - 30_000);
    assert.equal(verifyTotp(driftedToken, secret, now, 1), true, 'Token within 1-step window must verify');

    // Beyond window fails
    const ancientToken = generateTotp(secret, now - 120_000);
    assert.equal(verifyTotp(ancientToken, secret, now, 1), false, 'Token beyond window drift must be rejected');
  });

  test('Unguessable session token generation', () => {
    const { rawToken, tokenHash } = generateSessionToken();
    assert.equal(rawToken.length, 64, 'Raw token must be 32 bytes hex (64 chars)');
    assert.equal(tokenHash.length, 64, 'SHA-256 token hash must be 64 hex chars');
  });
});

describe('2. Central Authorization Policy Engine (Deny by Default)', () => {
  const patientActor: ActorContext = { userId: 'patient-uuid-1', role: 'PATIENT' };
  const doctorActor: ActorContext = {
    userId: 'user-doc-1',
    role: 'DOCTOR',
    clinicianId: 'doc-uuid-1',
    facilityId: 'facility-lagos-1',
    isVerifiedClinician: true,
  };
  const unverifiedDoctorActor: ActorContext = {
    ...doctorActor,
    isVerifiedClinician: false,
  };
  const platformAdminActor: ActorContext = { userId: 'admin-uuid-1', role: 'PLATFORM_ADMIN' };

  test('Unauthenticated actor is rejected', () => {
    const decision = evaluatePolicy({
      actor: null as any,
      action: 'PATIENT_READ_RECORD',
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.statusCode, 401);
  });

  test('Patient reading own record is allowed; reading another patient is denied', () => {
    const ownRecord = evaluatePolicy({
      actor: patientActor,
      action: 'PATIENT_READ_RECORD',
      targetPatientId: 'patient-uuid-1',
    });
    assert.equal(ownRecord.allowed, true);
    assert.equal(ownRecord.statusCode, 200);

    const otherRecord = evaluatePolicy({
      actor: patientActor,
      action: 'PATIENT_READ_RECORD',
      targetPatientId: 'victim-patient-999',
    });
    assert.equal(otherRecord.allowed, false);
    assert.equal(otherRecord.statusCode, 403);
  });

  test('Unverified clinician is completely denied clinical actions', () => {
    const decision = evaluatePolicy({
      actor: unverifiedDoctorActor,
      action: 'PATIENT_READ_RECORD',
      targetPatientId: 'patient-uuid-1',
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.statusCode, 403);
    assert.match(decision.reason, /unverified/i);
  });

  test('Doctor with NO consent is denied access (403)', () => {
    const decision = evaluatePolicy({
      actor: doctorActor,
      action: 'PATIENT_READ_RECORD',
      targetPatientId: 'patient-uuid-1',
      activeConsent: null,
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.statusCode, 403);
  });

  test('Doctor with valid active consent is granted access', () => {
    const validConsent: ConsentContext = {
      id: 'consent-1',
      patientId: 'patient-uuid-1',
      targetFacilityId: 'facility-lagos-1',
      scopes: ['all'],
      validUntil: new Date(Date.now() + 86400_000), // Valid for 24h
      isRevoked: false,
    };

    const decision = evaluatePolicy({
      actor: doctorActor,
      action: 'PATIENT_READ_RECORD',
      targetPatientId: 'patient-uuid-1',
      activeConsent: validConsent,
    });
    assert.equal(decision.allowed, true);
    assert.equal(decision.statusCode, 200);
  });

  test('Doctor with expired or revoked consent is denied (403)', () => {
    const expiredConsent: ConsentContext = {
      id: 'consent-2',
      patientId: 'patient-uuid-1',
      targetFacilityId: 'facility-lagos-1',
      scopes: ['all'],
      validUntil: new Date(Date.now() - 3600_000), // Expired 1h ago
      isRevoked: false,
    };

    const expiredDecision = evaluatePolicy({
      actor: doctorActor,
      action: 'PATIENT_READ_RECORD',
      targetPatientId: 'patient-uuid-1',
      activeConsent: expiredConsent,
    });
    assert.equal(expiredDecision.allowed, false);
    assert.equal(expiredDecision.statusCode, 403);

    const revokedConsent: ConsentContext = {
      ...expiredConsent,
      validUntil: new Date(Date.now() + 86400_000),
      isRevoked: true,
    };

    const revokedDecision = evaluatePolicy({
      actor: doctorActor,
      action: 'PATIENT_READ_RECORD',
      targetPatientId: 'patient-uuid-1',
      activeConsent: revokedConsent,
    });
    assert.equal(revokedDecision.allowed, false);
    assert.equal(revokedDecision.statusCode, 403);
  });

  test('Emergency Break-Glass workflow: 60-min TTL and dual co-sign rule', () => {
    const activeEmergencyGrant: EmergencyGrantContext = {
      id: 'grant-emer-1',
      patientId: 'patient-uuid-1',
      clinicianId: 'doc-uuid-1',
      facilityId: 'facility-lagos-1',
      expiresAt: new Date(Date.now() + 1800_000), // 30 min remaining
      fullHistoryAccess: false,
    };

    // Summary read is allowed under active emergency grant
    const summaryDecision = evaluatePolicy({
      actor: doctorActor,
      action: 'EMERGENCY_READ_SUMMARY',
      targetPatientId: 'patient-uuid-1',
      activeEmergencyGrant,
    });
    assert.equal(summaryDecision.allowed, true);

    // Full history without co-sign is DENIED
    const fullHistoryWithoutCoSign = evaluatePolicy({
      actor: doctorActor,
      action: 'EMERGENCY_READ_FULL_HISTORY',
      targetPatientId: 'patient-uuid-1',
      activeEmergencyGrant,
    });
    assert.equal(fullHistoryWithoutCoSign.allowed, false);
    assert.equal(fullHistoryWithoutCoSign.statusCode, 403);
    assert.match(fullHistoryWithoutCoSign.reason, /co-sign/i);

    // Full history WITH dual clinician co-sign is ALLOWED
    const coSignedGrant: EmergencyGrantContext = {
      ...activeEmergencyGrant,
      fullHistoryAccess: true,
      coSignClinicianId: 'doc-uuid-second-consultant',
    };
    const fullHistoryWithCoSign = evaluatePolicy({
      actor: doctorActor,
      action: 'EMERGENCY_READ_FULL_HISTORY',
      targetPatientId: 'patient-uuid-1',
      activeEmergencyGrant: coSignedGrant,
    });
    assert.equal(fullHistoryWithCoSign.allowed, true);
    assert.equal(fullHistoryWithCoSign.statusCode, 200);

    // Expired emergency grant (> 60 min elapsed) is DENIED
    const expiredGrant: EmergencyGrantContext = {
      ...activeEmergencyGrant,
      expiresAt: new Date(Date.now() - 60_000), // Expired 1 min ago
    };
    const expiredEmergency = evaluatePolicy({
      actor: doctorActor,
      action: 'EMERGENCY_READ_SUMMARY',
      targetPatientId: 'patient-uuid-1',
      activeEmergencyGrant: expiredGrant,
    });
    assert.equal(expiredEmergency.allowed, false);
    assert.equal(expiredEmergency.statusCode, 403);
  });

  test('Platform admin cannot view patient medical PHI, but can verify clinicians', () => {
    const adminReadPHI = evaluatePolicy({
      actor: platformAdminActor,
      action: 'PATIENT_READ_RECORD',
      targetPatientId: 'patient-uuid-1',
    });
    assert.equal(adminReadPHI.allowed, false);
    assert.equal(adminReadPHI.statusCode, 403);

    const adminVerify = evaluatePolicy({
      actor: platformAdminActor,
      action: 'CLINICIAN_VERIFY',
    });
    assert.equal(adminVerify.allowed, true);
    assert.equal(adminVerify.statusCode, 200);
  });
});

describe('3. Clinician Onboarding & MDCN License Verification', () => {
  const manager = new ClinicianVerificationManager();

  test('Validates MDCN license formats accurately', () => {
    assert.equal(validateMdcnLicenseFormat('MDCN/R/10294').valid, true);
    assert.equal(validateMdcnLicenseFormat('MDCN/F/29103').valid, true);
    assert.equal(validateMdcnLicenseFormat('mdcn/r/48201').valid, true); // Case insensitive normalization

    assert.equal(validateMdcnLicenseFormat('INVALID-1234').valid, false);
    assert.equal(validateMdcnLicenseFormat('MDCN/X/12345').valid, false); // Unknown category
  });

  test('Clinician onboarding workflow and state transitions', async () => {
    const submission: Omit<ClinicianProfile, 'status' | 'verifiedAt' | 'verifiedByAdminId'> = {
      id: 'clinician-test-1',
      userId: 'user-test-1',
      fullName: 'Dr. Robert Caldwell',
      licenseNumber: 'MDCN/R/10294',
      specialty: 'Cardiothoracic Surgery',
    };

    const onboarding = await manager.processOnboardingSubmission(submission);
    assert.equal(onboarding.profile.status, 'PENDING');

    // Platform admin approves
    const verified = manager.approveVerification(onboarding.profile, 'platform-admin-1');
    assert.equal(verified.status, 'VERIFIED');
    assert.ok(verified.verifiedAt instanceof Date);
    assert.equal(verified.verifiedByAdminId, 'platform-admin-1');

    // Cannot approve an already verified clinician
    assert.throws(() => {
      manager.approveVerification(verified, 'platform-admin-1');
    });

    // Suspension
    const suspended = manager.suspendClinician(verified, 'platform-admin-1', 'License review ongoing');
    assert.equal(suspended.status, 'SUSPENDED');
  });
});

describe('4. Append-Only Tamper-Evident Hash-Chained Audit Log', () => {
  test('Appends sequential records and validates uncorrupted chain integrity', () => {
    const auditManager = new AuditChainManager();

    // 1. Genesis entry
    const entry1 = auditManager.appendEntry({
      actorId: 'user-patient-1',
      subjectId: 'patient-uuid-1',
      action: 'PATIENT_LOGIN',
      accessType: 'NORMAL_CONSENT',
      ipAddress: '197.210.64.1',
      userAgent: 'Mozilla/5.0 Android',
    });

    assert.equal(entry1.previousHash, GENESIS_HASH, 'First block must link to genesis hash');
    assert.equal(entry1.sequenceNumber, 1);

    // 2. Clinician Emergency Access entry
    const entry2 = auditManager.appendEntry({
      actorId: 'doc-uuid-1',
      subjectId: 'patient-uuid-1',
      action: 'EMERGENCY_BREAK_GLASS',
      accessType: 'EMERGENCY_BREAK_GLASS',
      facilityId: 'facility-lagos-1',
      reason: 'UNCONSCIOUS',
      ipAddress: '102.89.44.12',
      userAgent: 'ClinicalTablet/1.0',
    });

    assert.equal(entry2.previousHash, entry1.currentHash, 'Second block must link to first block hash');
    assert.equal(entry2.sequenceNumber, 2);

    // 3. Clinical Observation Write entry
    const entry3 = auditManager.appendEntry({
      actorId: 'doc-uuid-1',
      subjectId: 'patient-uuid-1',
      action: 'OBSERVATION_WRITE',
      accessType: 'EMERGENCY_BREAK_GLASS',
      resourceType: 'Observation',
      resourceId: 'obs-vitals-102',
      facilityId: 'facility-lagos-1',
      ipAddress: '102.89.44.12',
      userAgent: 'ClinicalTablet/1.0',
    });

    assert.equal(entry3.previousHash, entry2.currentHash);
    assert.equal(entry3.sequenceNumber, 3);

    // Verify pristine chain
    const verification = auditManager.verifyChain();
    assert.equal(verification.valid, true, 'Pristine hash chain must pass verification');
  });

  test('Cryptographic tamper detection flags altered rows', () => {
    const auditManager = new AuditChainManager();

    auditManager.appendEntry({
      actorId: 'doc-uuid-1',
      subjectId: 'patient-uuid-1',
      action: 'EMERGENCY_BREAK_GLASS',
      accessType: 'EMERGENCY_BREAK_GLASS',
      reason: 'UNCONSCIOUS',
      ipAddress: '197.210.1.1',
      userAgent: 'Browser',
    });

    auditManager.appendEntry({
      actorId: 'doc-uuid-1',
      subjectId: 'patient-uuid-1',
      action: 'RECORD_READ',
      accessType: 'EMERGENCY_BREAK_GLASS',
      reason: 'CHECK_ALLERGIES',
      ipAddress: '197.210.1.1',
      userAgent: 'Browser',
    });

    auditManager.appendEntry({
      actorId: 'patient-uuid-1',
      subjectId: 'patient-uuid-1',
      action: 'PATIENT_EXPORT_ALL',
      accessType: 'NORMAL_CONSENT',
      ipAddress: '102.88.1.1',
      userAgent: 'Browser',
    });

    // Baseline passes
    assert.equal(auditManager.verifyChain().valid, true);

    // Rogue actor tries to alter entry #2 to conceal an unauthorized access reason
    const entries = auditManager.getEntries();
    entries[1].reason = 'ALTERED_REASON_BY_ATTACKER';

    const corruptedManager = new AuditChainManager(entries);
    const result = corruptedManager.verifyChain();

    assert.equal(result.valid, false, 'Tampered chain must be detected');
    assert.equal(result.corruptedIndex, 1, 'Must identify exact index where hash mismatch occurred');
    assert.match(result.error || '', /Tamper detected at sequence 2/);
  });

  test('Patient access history retrieval ("Who accessed my record")', () => {
    const auditManager = new AuditChainManager();

    auditManager.appendEntry({
      actorId: 'doc-1',
      subjectId: 'patient-A',
      action: 'EMERGENCY_BREAK_GLASS',
      accessType: 'EMERGENCY_BREAK_GLASS',
      ipAddress: '10.0.0.1',
      userAgent: 'Tab',
    });

    auditManager.appendEntry({
      actorId: 'doc-2',
      subjectId: 'patient-B',
      action: 'RECORD_READ',
      accessType: 'NORMAL_CONSENT',
      ipAddress: '10.0.0.2',
      userAgent: 'Tab',
    });

    auditManager.appendEntry({
      actorId: 'doc-3',
      subjectId: 'patient-A',
      action: 'RECORD_READ',
      accessType: 'NORMAL_CONSENT',
      ipAddress: '10.0.0.3',
      userAgent: 'Tab',
    });

    const patientAHistory = auditManager.getPatientAccessHistory('patient-A');
    assert.equal(patientAHistory.length, 2);
    assert.ok(patientAHistory.every((e) => e.subjectId === 'patient-A'));
  });
});

