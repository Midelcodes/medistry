/**
 * Phase 5 Comprehensive Test Suite
 * Tests: Cross-Hospital Safe Lookup, Access Requests, In-App Approval, SMS OTP Approval,
 * Pre-Shared Links, Instant Revocation, Access Log ("Who Accessed My Record"), and Dispute Escalation.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { AuditChainManager } from '../src/lib/audit/hashChain.ts';
import { ConsentLifecycleManager } from '../src/lib/consent/consentManager.ts';
import { PatientAccessLogManager } from '../src/lib/audit/accessLogManager.ts';
import { ClinicalDataStore } from '../src/lib/clinical/store.ts';
import { createPatientRecord, type PatientEntity } from '../src/lib/patient/profile.ts';
import { evaluatePolicy, type ActorContext } from '../src/lib/policy/enforcer.ts';
import type { FHIRCondition } from '../src/lib/fhir/types.ts';

describe('1. Safe Patient Lookup & Identity Redaction', () => {
  const auditManager = new AuditChainManager();
  const consentManager = new ConsentLifecycleManager(auditManager);

  const patientDatabase = new Map<string, PatientEntity>();
  const patient = createPatientRecord(
    { firstName: 'Emeka', lastName: 'Nnamdi', dateOfBirth: '1985-04-12', gender: 'male' },
    { bloodGroup: 'O_POSITIVE', genotype: 'AA' },
    { userId: 'user-emeka-1' }
  );
  patientDatabase.set(patient.id, patient);

  test('Lookup by Patient ID and matching Date of Birth returns safe redacted preview', () => {
    const lookup = consentManager.lookupPatientSafe(
      { patientId: patient.id, dateOfBirth: '1985-04-12' },
      patientDatabase,
      () => ({ valid: false })
    );

    assert.equal(lookup.found, true);
    assert.equal(lookup.patientId, patient.id);
    assert.equal(lookup.redactedPreview?.initials, 'E. N.');
    assert.equal(lookup.redactedPreview?.birthYear, '1985');
    assert.equal(lookup.redactedPreview?.gender, 'MALE');
  });

  test('Lookup with incorrect Date of Birth fails without exposing data', () => {
    const lookup = consentManager.lookupPatientSafe(
      { patientId: patient.id, dateOfBirth: '1990-01-01' }, // Wrong DOB
      patientDatabase,
      () => ({ valid: false })
    );
    assert.equal(lookup.found, false);
  });
});

describe('2. In-App Consent Approval & Policy Synchronization', () => {
  const auditManager = new AuditChainManager();
  const consentManager = new ConsentLifecycleManager(auditManager);
  const patientId = 'patient-uuid-emeka';

  const doctorActor: ActorContext = {
    userId: 'user-doc-lagos',
    role: 'DOCTOR',
    clinicianId: 'doc-uuid-1',
    facilityId: 'facility-lagos-1',
    isVerifiedClinician: true,
  };

  test('Clinician requests access, patient approves in-app, policy grants access', () => {
    // 1. Clinician requests access for 7 days
    const request = consentManager.createAccessRequest({
      patientId,
      clinicianId: doctorActor.clinicianId!,
      clinicianName: 'Dr. Robert Caldwell',
      facilityId: 'facility-lagos-1',
      facilityName: 'Lagos University Teaching Hospital',
      requestedScopes: ['all'],
      durationPreset: 'SEVEN_DAYS',
      clinicalReason: 'Cardiology outpatient consultation referral',
    });

    assert.ok(request.requestId);
    assert.ok(request.rawOtp);

    // Baseline: before approval, policy engine forbids access
    const beforeApproval = evaluatePolicy({
      actor: doctorActor,
      action: 'PATIENT_READ_RECORD',
      targetPatientId: patientId,
      activeConsent: null,
    });
    assert.equal(beforeApproval.allowed, false);
    assert.equal(beforeApproval.statusCode, 403);

    // 2. Patient approves in-app
    const grant = consentManager.approveInApp(request.requestId, patientId);
    assert.equal(grant.patientId, patientId);
    assert.equal(grant.targetClinicianId, 'doc-uuid-1');
    assert.equal(grant.isRevoked, false);

    // 3. Resolve active consent and evaluate policy
    const activeConsent = consentManager.resolveActiveConsent(patientId, doctorActor.clinicianId!, doctorActor.facilityId!);
    assert.ok(activeConsent);

    const afterApproval = evaluatePolicy({
      actor: doctorActor,
      action: 'PATIENT_READ_RECORD',
      targetPatientId: patientId,
      activeConsent,
    });
    assert.equal(afterApproval.allowed, true);
    assert.equal(afterApproval.statusCode, 200);
  });
});

describe('3. One-Time Passcode (OTP) Approval Flow', () => {
  const auditManager = new AuditChainManager();
  const consentManager = new ConsentLifecycleManager(auditManager);
  const patientId = 'patient-uuid-otp-flow';

  test('Verifying with correct OTP grants access; wrong OTP decrements attempt countdown', () => {
    const request = consentManager.createAccessRequest({
      patientId,
      clinicianId: 'doc-uuid-2',
      clinicianName: 'Dr. Elena Rostova',
      facilityId: 'facility-abuja-1',
      facilityName: 'National Hospital Abuja',
      requestedScopes: ['Condition', 'MedicationStatement'],
      durationPreset: 'ONE_VISIT',
      clinicalReason: 'Neurology clinic intake',
    });

    // Wrong OTP attempt
    assert.throws(() => {
      consentManager.approveViaOtp(request.requestId, '000000');
    }, /Invalid OTP\. 2 attempts remaining/);

    // Correct OTP attempt
    const grant = consentManager.approveViaOtp(request.requestId, request.rawOtp);
    assert.equal(grant.patientId, patientId);
    assert.equal(grant.scopes[0], 'Condition');

    // Replay attempt fails
    assert.throws(() => {
      consentManager.approveViaOtp(request.requestId, request.rawOtp);
    }, /already APPROVED/);
  });
});

describe('4. Pre-Shared Facility Links & Instant Revocation', () => {
  const auditManager = new AuditChainManager();
  const consentManager = new ConsentLifecycleManager(auditManager);
  const store = new ClinicalDataStore(auditManager);
  const patientId = 'patient-uuid-preshared';

  const doctorAbuja: ActorContext = {
    userId: 'user-doc-2',
    role: 'DOCTOR',
    clinicianId: 'doc-uuid-2',
    facilityId: 'facility-abuja-1',
    isVerifiedClinician: true,
  };

  test('Patient pre-shares record with Abuja facility before arrival', () => {
    const { grant, preSharedToken } = consentManager.generatePreSharedGrant(
      patientId,
      'facility-abuja-1',
      'National Hospital Abuja',
      ['all'],
      48
    );

    assert.ok(preSharedToken);
    assert.equal(grant.targetFacilityId, 'facility-abuja-1');

    // Doctor at Abuja can read record
    const activeConsent = consentManager.resolveActiveConsent(patientId, doctorAbuja.clinicianId!, doctorAbuja.facilityId!);
    assert.ok(activeConsent);

    const decision = evaluatePolicy({
      actor: doctorAbuja,
      action: 'PATIENT_READ_RECORD',
      targetPatientId: patientId,
      activeConsent,
    });
    assert.equal(decision.allowed, true);
  });

  test('Patient instant revocation immediately locks out clinician', () => {
    const patientRevokeId = 'patient-uuid-revocation-test';
    const { grant } = consentManager.generatePreSharedGrant(
      patientRevokeId,
      'facility-abuja-1',
      'National Hospital Abuja',
      ['all'],
      48
    );

    // Patient revokes consent
    const revoked = consentManager.revokeConsent(patientRevokeId, grant.id, 'Patient cancelled hospital appointment');
    assert.equal(revoked.isRevoked, true);

    // Subsequent resolution returns null
    const activeConsent = consentManager.resolveActiveConsent(patientRevokeId, doctorAbuja.clinicianId!, doctorAbuja.facilityId!);
    assert.equal(activeConsent, null);

    // Policy engine denies access
    const decision = evaluatePolicy({
      actor: doctorAbuja,
      action: 'PATIENT_READ_RECORD',
      targetPatientId: patientRevokeId,
      activeConsent,
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.statusCode, 403);
  });
});

describe('5. Patient Access-Log ("Who Accessed My Record") & Dispute Escalation', () => {
  const auditManager = new AuditChainManager();
  const accessLogManager = new PatientAccessLogManager(auditManager);
  const patientId = 'patient-uuid-access-log';

  // Simulate clinical events
  auditManager.appendEntry({
    actorId: 'doc-uuid-1',
    subjectId: patientId,
    action: 'CLINICAL_RECORDS_READ_BATCH',
    accessType: 'NORMAL_CONSENT',
    facilityId: 'facility-lagos-1',
    ipAddress: '197.210.1.1',
    userAgent: 'ClinicalClient/1.0',
    reason: 'Routine outpatient consultation',
  });

  auditManager.appendEntry({
    actorId: 'doc-uuid-3',
    subjectId: patientId,
    action: 'EMERGENCY_BREAK_GLASS',
    accessType: 'EMERGENCY_BREAK_GLASS',
    facilityId: 'facility-lagos-1',
    ipAddress: '102.89.2.2',
    userAgent: 'ER_Tablet/1.0',
    reason: 'UNCONSCIOUS_CRITICAL_TRAUMA',
  });

  test('Retrieves formatted human-friendly access history', () => {
    const logs = accessLogManager.getPatientAccessLog(patientId);
    assert.equal(logs.length, 2);

    const emergencyEntry = logs.find((l) => l.isEmergency);
    assert.ok(emergencyEntry);
    assert.equal(emergencyEntry.accessTypeLabel, 'Emergency Break-Glass');
    assert.ok(emergencyEntry.actorName.includes('Dr. Marcus Thorne'));
    assert.ok(emergencyEntry.facilityName.includes('Lagos University Teaching Hospital'));
  });

  test('Patient disputes an unrecognized access event and escalates to Platform Admin', () => {
    const logs = accessLogManager.getPatientAccessLog(patientId);
    const targetAuditId = logs[0].auditId;

    // Patient disputes
    const ticket = accessLogManager.disputeAccess(
      patientId,
      targetAuditId,
      'I was not in Lagos on this date and did not visit this clinic'
    );

    assert.equal(ticket.status, 'PENDING_REVIEW');
    assert.equal(ticket.patientId, patientId);

    // Verify access log reflects disputed state
    const updatedLogs = accessLogManager.getPatientAccessLog(patientId);
    const disputedEntry = updatedLogs.find((l) => l.auditId === targetAuditId)!;
    assert.equal(disputedEntry.isDisputed, true);
    assert.match(disputedEntry.disputeReason || '', /not in Lagos/);

    // Platform admin investigates and resolves dispute
    const resolved = accessLogManager.resolveDispute(
      ticket.ticketId,
      'admin-platform-1',
      'RESOLVED_BREACH',
      'Clinician entered wrong patient ID; access revoked, clinician cautioned'
    );
    assert.equal(resolved.status, 'RESOLVED_BREACH');
    assert.match(resolved.adminNotes || '', /wrong patient ID/);
  });
});
