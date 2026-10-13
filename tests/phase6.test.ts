import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AuditChainManager } from '../src/lib/audit/hashChain.ts';
import { ClinicalDataStore } from '../src/lib/clinical/store.ts';
import { ClinicalTimelineEngine } from '../src/lib/clinical/timeline.ts';
import { NotificationDispatcher, ConsoleNotificationProvider } from '../src/lib/notifications/dispatcher.ts';
import { EmergencyBreakGlassEngine } from '../src/lib/emergency/breakGlassEngine.ts';
import { renderEmergencySummaryHtml } from '../src/lib/emergency/summaryRenderer.ts';
import { OfflineEmergencyCardManager } from '../src/lib/emergency/offlineCard.ts';
import { createPatientRecord, type PatientEntity } from '../src/lib/patient/profile.ts';
import type { ActorContext } from '../src/lib/policy/enforcer.ts';

describe('1. Public Emergency Gate & Patient Opt-in Controls', () => {
  let auditManager: AuditChainManager;
  let clinicalStore: ClinicalDataStore;
  let timelineEngine: ClinicalTimelineEngine;
  let dispatcher: NotificationDispatcher;
  let engine: EmergencyBreakGlassEngine;

  beforeEach(() => {
    auditManager = new AuditChainManager();
    clinicalStore = new ClinicalDataStore(auditManager);
    timelineEngine = new ClinicalTimelineEngine(clinicalStore);
    dispatcher = new NotificationDispatcher();
    engine = new EmergencyBreakGlassEngine(auditManager, clinicalStore, timelineEngine, dispatcher);
  });

  test('Anonymous scanner receives login requirement when patient has default opt-in OFF', () => {
    const patient = createPatientRecord(
      { firstName: 'Amara', lastName: 'Okonkwo', dateOfBirth: '1998-04-12', gender: 'female' },
      {
        bloodGroup: 'O_POSITIVE',
        genotype: 'SS',
        allergies: [
          { substance: 'Penicillin', category: 'drug', reaction: 'Anaphylaxis', severity: 'severe' },
        ],
        emergencyContacts: [
          { id: 'c1', name: 'Emeka Okonkwo', relationship: 'Brother', phone: '+234 802 111 2233', priority: 1 },
        ],
        publicEmergencyOptIn: false, // Default OFF
      },
      { userId: 'user-amara-01', countryCode: 'NG' }
    );

    const gate = engine.evaluatePublicScanGate(patient);
    assert.strictEqual(gate.requiresLogin, true);
    assert.strictEqual(gate.publicCard, undefined);
  });

  test('Patient who opted IN exposes minimal emergency triage badge without login', () => {
    const patient = createPatientRecord(
      { firstName: 'Amara', lastName: 'Okonkwo', dateOfBirth: '1998-04-12', gender: 'female' },
      {
        bloodGroup: 'O_POSITIVE',
        genotype: 'SS',
        allergies: [
          { substance: 'Penicillin', category: 'drug', reaction: 'Anaphylaxis', severity: 'severe' },
        ],
        emergencyContacts: [
          { id: 'c1', name: 'Emeka Okonkwo', relationship: 'Brother', phone: '+234 802 111 2233', priority: 1 },
        ],
        publicEmergencyOptIn: true, // Patient opted in
      },
      { userId: 'user-amara-01', countryCode: 'NG' }
    );

    const gate = engine.evaluatePublicScanGate(patient);
    assert.strictEqual(gate.requiresLogin, false);
    assert.ok(gate.publicCard);
    assert.strictEqual(gate.publicCard.bloodGroup, 'O POSITIVE');
    assert.strictEqual(gate.publicCard.genotype, 'SS');
    assert.ok(gate.publicCard.allergies.some(a => a.includes('Penicillin')));
    assert.strictEqual(gate.publicCard.emergencyHotline, '+234 802 111 2233');
  });
});

describe('2. Emergency Break-Glass Execution & Audit Trail', () => {
  let auditManager: AuditChainManager;
  let clinicalStore: ClinicalDataStore;
  let timelineEngine: ClinicalTimelineEngine;
  let consoleProvider: ConsoleNotificationProvider;
  let dispatcher: NotificationDispatcher;
  let engine: EmergencyBreakGlassEngine;

  beforeEach(() => {
    auditManager = new AuditChainManager();
    clinicalStore = new ClinicalDataStore(auditManager);
    timelineEngine = new ClinicalTimelineEngine(clinicalStore);
    consoleProvider = new ConsoleNotificationProvider();
    dispatcher = new NotificationDispatcher(consoleProvider);
    engine = new EmergencyBreakGlassEngine(auditManager, clinicalStore, timelineEngine, dispatcher);
  });

  function buildTestPatient(): PatientEntity {
    return createPatientRecord(
      { firstName: 'Babajide', lastName: 'Adeleke', dateOfBirth: '1985-08-20', gender: 'male' },
      {
        bloodGroup: 'B_NEGATIVE',
        genotype: 'AA',
        allergies: [
          { substance: 'Aspirin', category: 'drug', reaction: 'Bronchospasm', severity: 'severe' },
        ],
        chronicConditions: ['Asthma'],
        activeMedications: [{ medicationName: 'Salbutamol Inhaler', dose: '100mcg PRN', route: 'inhalation', sinceDate: '2020-03-10' }],
        emergencyContacts: [
          { id: 'c2', name: 'Kemi Adeleke', relationship: 'Spouse', phone: '+234 803 999 8877', email: 'kemi@example.ng', priority: 1 },
        ],
        advanceDirectiveDnr: true,
        organDonor: false,
        publicEmergencyOptIn: false,
      },
      { userId: 'user-adeleke-01', countryCode: 'NG', primaryFacilityId: 'fac-luth-001' }
    );
  }

  test('Rejects break-glass if actor is not a verified medical doctor', async () => {
    const patient = buildTestPatient();
    const unverifiedDoctorActor: ActorContext = {
      userId: 'user-doc-unverified',
      role: 'DOCTOR',
      isVerifiedClinician: false,
    };

    await assert.rejects(
      async () => {
        await engine.initiateBreakGlass({
          patient,
          emergencyCode: 'K7QM-4T9X-2HDP-8W2',
          actor: unverifiedDoctorActor,
          treatingDoctorName: 'Dr. Unverified',
          facilityId: 'fac-luth-001',
          facilityName: 'Lagos University Teaching Hospital',
          reason: 'UNCONSCIOUS',
        });
      },
      /Only verified medical doctors/
    );
  });

  test('Requires mandatory clinical description when selecting reason "OTHER"', async () => {
    const patient = buildTestPatient();
    const verifiedDoctor: ActorContext = {
      userId: 'user-doc-verified',
      role: 'DOCTOR',
      clinicianId: 'clinician-mdcn-7788',
      isVerifiedClinician: true,
    };

    await assert.rejects(
      async () => {
        await engine.initiateBreakGlass({
          patient,
          emergencyCode: 'K7QM-4T9X-2HDP-8W2',
          actor: verifiedDoctor,
          treatingDoctorName: 'Dr. Robert Caldwell',
          facilityId: 'fac-luth-001',
          facilityName: 'LUTH Emergency Room',
          reason: 'OTHER',
          reasonDetails: '',
        });
      },
      /Mandatory clinical justification is required/
    );
  });

  test('Successfully initiates 60-min time-boxed emergency grant and logs immutable audit row', async () => {
    const patient = buildTestPatient();
    const verifiedDoctor: ActorContext = {
      userId: 'user-doc-verified',
      role: 'DOCTOR',
      clinicianId: 'clinician-mdcn-7788',
      isVerifiedClinician: true,
    };

    const { grant } = await engine.initiateBreakGlass({
      patient,
      emergencyCode: 'K7QM-4T9X-2HDP-8W2',
      actor: verifiedDoctor,
      treatingDoctorName: 'Dr. Robert Caldwell',
      facilityId: 'fac-luth-001',
      facilityName: 'LUTH Emergency Department',
      reason: 'UNCONSCIOUS',
    });

    assert.ok(grant.id);
    assert.strictEqual(grant.fullHistoryAccess, false);
    assert.strictEqual(grant.reason, 'UNCONSCIOUS');

    // 60-minute time-box check
    const diffMin = Math.round((grant.expiresAt.getTime() - new Date(grant.grantedAt).getTime()) / (60 * 1000));
    assert.strictEqual(diffMin, 60);

    // Audit Row Check
    const auditChain = auditManager.getChain();
    const breakGlassAudit = auditChain.find(e => e.action === 'EMERGENCY_BREAK_GLASS_INITIATED');
    assert.ok(breakGlassAudit);
    assert.strictEqual(breakGlassAudit.actorId, 'user-doc-verified');
    assert.strictEqual(breakGlassAudit.subjectId, patient.id);
    assert.strictEqual(breakGlassAudit.accessType, 'EMERGENCY_BREAK_GLASS');
  });
});

describe('3. Automated Multi-Channel Notifications & Telecom Outage Resilience', () => {
  let consoleProvider: ConsoleNotificationProvider;
  let dispatcher: NotificationDispatcher;

  beforeEach(() => {
    consoleProvider = new ConsoleNotificationProvider();
    dispatcher = new NotificationDispatcher(consoleProvider);
  });

  const patientAlertInfo = {
    id: 'patient-alert-01',
    fullName: 'Chinedu Eze',
    phone: '+234 803 123 4567',
    email: 'chinedu@example.ng',
    emergencyContacts: [
      { name: 'Ngozi Eze', relationship: 'Mother', phone: '+234 802 345 6789', email: 'ngozi@example.ng' },
    ],
  };

  test('Delivers SMS alerts cleanly under normal telecom operating conditions', async () => {
    const results = await dispatcher.dispatchEmergencyBreakGlassAlerts(patientAlertInfo, {
      doctorName: 'Dr. Robert Caldwell',
      facilityName: 'Lagos University Teaching Hospital',
      reason: 'UNCONSCIOUS',
      timestamp: new Date().toISOString(),
    });

    assert.strictEqual(results.length, 2);
    assert.ok(results.every(r => r.status === 'DELIVERED' && r.channel === 'SMS'));
    assert.strictEqual(consoleProvider.sentSmsLogs.length, 2);
    assert.ok(consoleProvider.sentSmsLogs[0].message.includes('EMERGENCY BREAK-GLASS ALERT'));
  });

  test('Gracefully degrades to Email and Push when SMS telecom providers encounter outages', async () => {
    consoleProvider.forceSmsFailure = true;

    const results = await dispatcher.dispatchEmergencyBreakGlassAlerts(patientAlertInfo, {
      doctorName: 'Dr. Robert Caldwell',
      facilityName: 'LUTH Emergency Department',
      reason: 'LIFE_THREATENING',
      timestamp: new Date().toISOString(),
    });

    const patientSms = results.find(r => r.recipient === patientAlertInfo.phone);
    assert.strictEqual(patientSms?.status, 'FAILED');

    const patientEmail = results.find(r => r.recipient === patientAlertInfo.email);
    assert.strictEqual(patientEmail?.status, 'FALLBACK_DELIVERED');
    assert.strictEqual(patientEmail?.channel, 'EMAIL');

    const patientPush = results.find(r => r.recipient === patientAlertInfo.id);
    assert.strictEqual(patientPush?.status, 'FALLBACK_DELIVERED');
    assert.strictEqual(patientPush?.channel, 'PUSH');

    assert.strictEqual(consoleProvider.sentEmailLogs.length, 2);
    assert.strictEqual(consoleProvider.sentPushLogs.length, 1);
  });
});

describe('4. Emergency Summary Compilation & < 50 KB HTML Template', () => {
  let auditManager: AuditChainManager;
  let clinicalStore: ClinicalDataStore;
  let timelineEngine: ClinicalTimelineEngine;
  let dispatcher: NotificationDispatcher;
  let engine: EmergencyBreakGlassEngine;

  beforeEach(() => {
    auditManager = new AuditChainManager();
    clinicalStore = new ClinicalDataStore(auditManager);
    timelineEngine = new ClinicalTimelineEngine(clinicalStore);
    dispatcher = new NotificationDispatcher();
    engine = new EmergencyBreakGlassEngine(auditManager, clinicalStore, timelineEngine, dispatcher);
  });

  test('Compiles emergency summary data with drug allergies prioritized first', async () => {
    const patient = createPatientRecord(
      { firstName: 'Halima', lastName: 'Bello', dateOfBirth: '1995-12-05', gender: 'female' },
      {
        bloodGroup: 'AB_POSITIVE',
        genotype: 'AS',
        allergies: [
          { substance: 'Amoxicillin', category: 'drug', reaction: 'Anaphylaxis', severity: 'severe' },
          { substance: 'Shellfish', category: 'food', reaction: 'Swelling', severity: 'moderate' },
        ],
        chronicConditions: ['Hypertension', 'Mild Asthma'],
        activeMedications: [
          { medicationName: 'Amlodipine', dose: '5mg daily', route: 'oral', sinceDate: '2023-04-10' },
        ],
        emergencyContacts: [
          { id: 'c3', name: 'Aliyu Bello', relationship: 'Husband', phone: '+234 809 555 4433', priority: 1 },
        ],
        advanceDirectiveDnr: true,
        organDonor: true,
        publicEmergencyOptIn: false,
      },
      { userId: 'user-halima-01', countryCode: 'NG', primaryFacilityId: 'fac-abuja-001' }
    );

    const verifiedDoctor: ActorContext = {
      userId: 'user-doc-halima',
      role: 'DOCTOR',
      clinicianId: 'clinician-mdcn-9999',
      isVerifiedClinician: true,
    };

    const { grant } = await engine.initiateBreakGlass({
      patient,
      emergencyCode: 'M8KN-2P4X-9H3Y-7W1',
      actor: verifiedDoctor,
      treatingDoctorName: 'Dr. Marcus Thorne',
      facilityId: 'fac-abuja-001',
      facilityName: 'National Hospital Abuja',
      reason: 'LIFE_THREATENING',
    });

    const summary = engine.buildEmergencySummary(patient, grant.id);

    // Verify drug allergy prioritization
    assert.strictEqual(summary.triageEssentials.drugAllergiesFirst.length, 1);
    assert.strictEqual(summary.triageEssentials.drugAllergiesFirst[0].substance, 'Amoxicillin');

    // Verify legal directives
    assert.strictEqual(summary.legalDirectives.advanceDirectiveDnr, true);
    assert.strictEqual(summary.legalDirectives.organDonor, true);
    assert.strictEqual(summary.grantMeta.fullHistoryAccess, false);
    assert.strictEqual(summary.grantMeta.remainingMinutes, 60);

    // Verify HTML Render
    const html = renderEmergencySummaryHtml(summary);
    const byteSize = Buffer.byteLength(html, 'utf-8');

    // Verify Size Benchmark: Under 50 KB
    assert.ok(byteSize < 50 * 1024, `HTML size was ${byteSize} bytes, which exceeds 50 KB`);
    assert.ok(byteSize > 2000, `HTML size was ${byteSize} bytes, unexpectedly small`);

    // Verify Content
    assert.ok(html.includes('DO NOT RESUSCITATE (DNR) ON FILE'));
    assert.ok(html.includes('Amoxicillin'));
    assert.ok(html.includes('AB POSITIVE'));
    assert.ok(html.includes('AS'));
    assert.ok(html.includes('tel:+234 809 555 4433'));
    assert.ok(html.includes('EXPIRES IN 60m'));
  });
});

describe('5. Dual-Clinician Co-Signing for Full Medical History', () => {
  let auditManager: AuditChainManager;
  let clinicalStore: ClinicalDataStore;
  let timelineEngine: ClinicalTimelineEngine;
  let dispatcher: NotificationDispatcher;
  let engine: EmergencyBreakGlassEngine;

  beforeEach(() => {
    auditManager = new AuditChainManager();
    clinicalStore = new ClinicalDataStore(auditManager);
    timelineEngine = new ClinicalTimelineEngine(clinicalStore);
    dispatcher = new NotificationDispatcher();
    engine = new EmergencyBreakGlassEngine(auditManager, clinicalStore, timelineEngine, dispatcher);
  });

  function buildPatient(): PatientEntity {
    return createPatientRecord(
      { firstName: 'Fatima', lastName: 'Garba', dateOfBirth: '2001-02-14', gender: 'female' },
      {
        bloodGroup: 'O_POSITIVE',
        genotype: 'AA',
        allergies: [],
        chronicConditions: [],
        activeMedications: [],
        emergencyContacts: [{ id: 'c4', name: 'Musa Garba', relationship: 'Father', phone: '+234 803 222 1100', priority: 1 }],
        advanceDirectiveDnr: false,
        organDonor: false,
        publicEmergencyOptIn: false,
      },
      { userId: 'user-garba-01', countryCode: 'NG', primaryFacilityId: 'fac-kano-001' }
    );
  }

  test('Rejects co-sign when attempted by the same primary attending clinician (Self-co-sign barred)', async () => {
    const patient = buildPatient();
    const primaryDoc: ActorContext = {
      userId: 'user-doc-1',
      role: 'DOCTOR',
      clinicianId: 'clinician-doc-1',
      isVerifiedClinician: true,
    };

    const { grant } = await engine.initiateBreakGlass({
      patient,
      emergencyCode: 'K7QM-4T9X-2HDP-8W2',
      actor: primaryDoc,
      treatingDoctorName: 'Dr. Primary Attending',
      facilityId: 'fac-kano-001',
      facilityName: 'Aminu Kano Teaching Hospital',
      reason: 'PATIENT_UNABLE_TO_CONSENT',
    });

    assert.throws(
      () => {
        engine.coSignForFullHistory({
          grantId: grant.id,
          primaryClinicianId: 'clinician-doc-1',
          coSignClinicianId: 'clinician-doc-1', // SAME CLINICIAN
          coSignDoctorName: 'Dr. Primary Attending',
          coSignReason: 'Need full record for surgery',
        });
      },
      /Co-signing requires a second, distinct attending clinician/
    );
  });

  test('Valid co-sign by distinct second clinician unlocks full history and writes tamper-evident audit row', async () => {
    const patient = buildPatient();
    const primaryDoc: ActorContext = {
      userId: 'user-doc-1',
      role: 'DOCTOR',
      clinicianId: 'clinician-doc-1',
      isVerifiedClinician: true,
    };

    const { grant } = await engine.initiateBreakGlass({
      patient,
      emergencyCode: 'K7QM-4T9X-2HDP-8W2',
      actor: primaryDoc,
      treatingDoctorName: 'Dr. Primary Attending',
      facilityId: 'fac-kano-001',
      facilityName: 'Aminu Kano Teaching Hospital',
      reason: 'UNCONSCIOUS',
    });

    const updatedGrant = engine.coSignForFullHistory({
      grantId: grant.id,
      primaryClinicianId: 'clinician-doc-1',
      coSignClinicianId: 'clinician-doc-2', // DISTINCT SECOND CLINICIAN
      coSignDoctorName: 'Dr. Aisha Bello',
      coSignReason: 'Emergency exploratory laparotomy required; need full anesthetic history',
    });

    assert.strictEqual(updatedGrant.fullHistoryAccess, true);
    assert.strictEqual(updatedGrant.coSignClinicianId, 'clinician-doc-2');

    const summary = engine.buildEmergencySummary(patient, grant.id);
    assert.strictEqual(summary.grantMeta.fullHistoryAccess, true);

    const html = renderEmergencySummaryHtml(summary);
    assert.ok(html.includes('Full Clinical History Unlocked via Dual Co-Sign'));
    assert.ok(html.includes('Dr. Aisha Bello'));

    const auditChain = auditManager.getChain();
    const coSignAudit = auditChain.find(e => e.action === 'EMERGENCY_CO_SIGN_FULL_HISTORY_GRANTED');
    assert.ok(coSignAudit);
    assert.strictEqual(coSignAudit.actorId, 'clinician-doc-2');
  });
});

describe('6. Offline Emergency Card Export & Verification', () => {
  let cardManager: OfflineEmergencyCardManager;

  beforeEach(() => {
    cardManager = new OfflineEmergencyCardManager('test_offline_key_2026_super_secret');
  });

  function buildPatient(): PatientEntity {
    return createPatientRecord(
      { firstName: 'Tunde', lastName: 'Bakare', dateOfBirth: '1979-05-18', gender: 'male' },
      {
        bloodGroup: 'A_POSITIVE',
        genotype: 'AA',
        allergies: [
          { substance: 'Sulfa Drugs', category: 'drug', reaction: 'Toxic Epidermal Necrolysis', severity: 'severe' },
        ],
        chronicConditions: ['Type 2 Diabetes'],
        activeMedications: [{ medicationName: 'Metformin', dose: '1000mg BID', route: 'oral', sinceDate: '2021-08-01' }],
        emergencyContacts: [
          { id: 'c5', name: 'Ronke Bakare', relationship: 'Wife', phone: '+234 802 444 3322', priority: 1 },
        ],
        advanceDirectiveDnr: false,
        organDonor: true,
        publicEmergencyOptIn: false,
      },
      { userId: 'user-tunde-01', countryCode: 'NG', primaryFacilityId: 'fac-ibadan-001' }
    );
  }

  test('Exports offline emergency card bundle with verified cryptographic signature', () => {
    const patient = buildPatient();
    const card = cardManager.exportOfflineEmergencyCard(patient, 'K7QM-4T9X-2HDP-8W2', 30);

    assert.strictEqual(card.patientId, patient.id);
    assert.strictEqual(card.triageData.bloodGroup, 'A POSITIVE');
    assert.strictEqual(card.triageData.genotype, 'AA');
    assert.strictEqual(card.triageData.organDonor, true);
    assert.ok(card.printableCardHtml.includes('A POSITIVE'));
    assert.ok(card.printableCardHtml.includes('Sulfa Drugs'));
    assert.ok(card.signedToken);

    // Verify offline signature
    const verification = cardManager.verifyOfflineCardToken(card.signedToken);
    assert.strictEqual(verification.valid, true);
    assert.strictEqual(verification.payload?.sub, patient.id);
    assert.strictEqual(verification.payload?.bloodGroup, 'A_POSITIVE');
  });

  test('Tampering with offline emergency token triggers verification failure', () => {
    const patient = buildPatient();
    const card = cardManager.exportOfflineEmergencyCard(patient, 'K7QM-4T9X-2HDP-8W2', 30);

    const tokenParts = card.signedToken.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(tokenParts[1], 'base64url').toString()),
        bloodGroup: 'O_NEGATIVE',
      })
    ).toString('base64url');
    const tamperedToken = `${tokenParts[0]}.${tamperedPayload}.${tokenParts[2]}`;

    const verification = cardManager.verifyOfflineCardToken(tamperedToken);
    assert.strictEqual(verification.valid, false);
    assert.strictEqual(verification.error, 'Cryptographic signature mismatch: offline card has been altered');
  });
});
