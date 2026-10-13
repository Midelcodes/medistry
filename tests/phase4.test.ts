/**
 * Phase 4 Comprehensive Test Suite
 * Tests: FHIR R4 Writes, Versioning, Immutability & Hard-Delete Safeguard,
 * Multi-Facility Timeline & Provenance, Secure Document Upload with Antivirus Scan,
 * and FHIR Bundle / Human Report Export.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { AuditChainManager } from '../src/lib/audit/hashChain.ts';
import { ClinicalDataStore } from '../src/lib/clinical/store.ts';
import { ClinicalTimelineEngine } from '../src/lib/clinical/timeline.ts';
import { SecureDocumentManager, EICAR_TEST_STRING } from '../src/lib/clinical/fileUpload.ts';
import { RecordExportEngine } from '../src/lib/clinical/export.ts';
import { createPatientRecord } from '../src/lib/patient/profile.ts';
import type { ActorContext, ConsentContext } from '../src/lib/policy/enforcer.ts';
import type {
  FHIREncounter,
  FHIRCondition,
  FHIRAllergyIntolerance,
  FHIRMedicationStatement,
} from '../src/lib/fhir/types.ts';

describe('1. FHIR R4 Resource Writes, Policy & AES-256-GCM Storage', () => {
  const auditManager = new AuditChainManager();
  const store = new ClinicalDataStore(auditManager);
  const patientId = 'patient-uuid-zainab';

  const doctorActor: ActorContext = {
    userId: 'user-doc-elena',
    role: 'DOCTOR',
    clinicianId: 'doc-uuid-2',
    facilityId: 'facility-lagos-1',
    isVerifiedClinician: true,
  };

  const validConsent: ConsentContext = {
    id: 'consent-zainab-1',
    patientId,
    targetFacilityId: 'facility-lagos-1',
    scopes: ['all'],
    validUntil: new Date(Date.now() + 86400_000),
    isRevoked: false,
  };

  test('Unconsented clinician cannot write records (403 Forbidden)', () => {
    const condition: FHIRCondition = {
      resourceType: 'Condition',
      id: 'cond-1',
      clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
      verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' }] },
      code: { text: 'Sickle Cell Anemia (Genotype SS)' },
      subject: { reference: `Patient/${patientId}` },
      recordedDate: '2026-10-12',
      recorder: { reference: 'Practitioner/doc-uuid-2' },
    };

    assert.throws(() => {
      store.writeRecord(patientId, condition, doctorActor, {
        facilityId: 'facility-lagos-1',
        consent: null, // No consent
      });
    }, /Forbidden: Access denied/);
  });

  test('Consented clinician writes valid FHIR Condition and Encounter encrypted at rest', () => {
    const encounter: FHIREncounter = {
      resourceType: 'Encounter',
      id: 'enc-luth-1',
      status: 'finished',
      class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'EMER', display: 'Emergency Acute Admission' },
      subject: { reference: `Patient/${patientId}` },
      participant: [{ individual: { reference: 'Practitioner/doc-uuid-2' } }],
      period: { start: '2026-10-12T08:00:00Z', end: '2026-10-12T14:30:00Z' },
      reasonCode: [{ text: 'Vaso-occlusive Crisis' }],
      serviceProvider: { reference: 'Organization/facility-lagos-1' },
    };

    const result = store.writeRecord(patientId, encounter, doctorActor, {
      facilityId: 'facility-lagos-1',
      consent: validConsent,
      category: 'emergency',
    });

    assert.equal(result.record.versionId, 1);
    assert.equal(result.record.isLatest, true);
    assert.equal(result.record.originFacilityId, 'facility-lagos-1');
    assert.equal(result.record.countryCode, 'NG');
    assert.notEqual(result.record.encryptedPayload, JSON.stringify(encounter), 'Payload must be encrypted at rest');
  });
});

describe('2. Versioning & Immutability (Hard-Delete Safeguard)', () => {
  const auditManager = new AuditChainManager();
  const store = new ClinicalDataStore(auditManager);
  const patientId = 'patient-uuid-versioning';

  const doctorActor: ActorContext = {
    userId: 'user-doc-robert',
    role: 'DOCTOR',
    clinicianId: 'doc-uuid-1',
    facilityId: 'facility-lagos-1',
    isVerifiedClinician: true,
  };

  const consent: ConsentContext = {
    id: 'consent-v1',
    patientId,
    targetFacilityId: 'facility-lagos-1',
    scopes: ['all'],
    validUntil: new Date(Date.now() + 86400_000),
    isRevoked: false,
  };

  test('Updating a diagnosis creates a new version while preserving the previous version', () => {
    const initialCondition: FHIRCondition = {
      resourceType: 'Condition',
      id: 'cond-initial-1',
      clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
      verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'provisional' }] },
      code: { text: 'Hypertension (Suspected)' },
      subject: { reference: `Patient/${patientId}` },
      recordedDate: '2026-10-10',
      recorder: { reference: 'Practitioner/doc-uuid-1' },
    };

    const written = store.writeRecord(patientId, initialCondition, doctorActor, {
      facilityId: 'facility-lagos-1',
      consent,
    });

    const v1Id = written.record.id;
    assert.equal(written.record.versionId, 1);
    assert.equal(written.record.isLatest, true);

    // Update to confirmed
    const updatedCondition: FHIRCondition = {
      ...initialCondition,
      verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' }] },
      code: { text: 'Essential Hypertension Stage 2' },
    };

    const updated = store.updateRecord(v1Id, updatedCondition, doctorActor, {
      facilityId: 'facility-lagos-1',
      consent,
      reason: 'Confirmed via 24-hr ambulatory BP monitoring',
    });

    assert.equal(updated.record.versionId, 2);
    assert.equal(updated.record.isLatest, true);
    assert.equal(updated.record.previousVersionId, v1Id);

    // Check v1 is preserved but marked non-latest
    const v1Stored = store.getRecordById(v1Id);
    assert.ok(v1Stored);
    assert.equal(v1Stored.isLatest, false, 'Previous version must be preserved as non-latest');
    assert.equal(v1Stored.versionId, 1);
  });

  test('Hard deletion attempts are strictly prohibited and throw an error', () => {
    assert.throws(() => {
      store.deleteRecord();
    }, /ERR_HARD_DELETE_PROHIBITED/);
  });
});

describe('3. Multi-Facility Chronological Timeline & Provenance', () => {
  const auditManager = new AuditChainManager();
  const store = new ClinicalDataStore(auditManager);
  const timelineEngine = new ClinicalTimelineEngine(store);
  const patientId = 'patient-uuid-multi-hospital';

  const doctorLagos: ActorContext = {
    userId: 'user-doc-1',
    role: 'DOCTOR',
    clinicianId: 'doc-uuid-1',
    facilityId: 'facility-lagos-1',
    isVerifiedClinician: true,
  };

  const doctorAbuja: ActorContext = {
    userId: 'user-doc-2',
    role: 'DOCTOR',
    clinicianId: 'doc-uuid-2',
    facilityId: 'facility-abuja-1',
    isVerifiedClinician: true,
  };

  const consent: ConsentContext = {
    id: 'consent-multi',
    patientId,
    scopes: ['all'],
    validUntil: new Date(Date.now() + 86400_000),
    isRevoked: false,
  };

  test('Aggregates multi-facility events with accurate provenance statements', () => {
    // 1. Hospital 1 (LUTH Lagos): Diagnosis
    const cond: FHIRCondition = {
      resourceType: 'Condition',
      id: 'cond-luth-101',
      clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
      verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' }] },
      code: { text: 'Sickle Cell Disease (HbSS)' },
      subject: { reference: `Patient/${patientId}` },
      recordedDate: '2026-05-10T10:00:00Z',
      recorder: { reference: 'Practitioner/doc-uuid-1' },
    };
    store.writeRecord(patientId, cond, doctorLagos, { facilityId: 'facility-lagos-1', consent });

    // 2. Hospital 2 (National Hospital Abuja): Medication
    const med: FHIRMedicationStatement = {
      resourceType: 'MedicationStatement',
      id: 'med-nha-201',
      status: 'active',
      medicationCodeableConcept: { text: 'Hydroxyurea 500mg Capsule' },
      subject: { reference: `Patient/${patientId}` },
      dateAsserted: '2026-08-15T14:00:00Z',
      dosage: [{ text: 'Take 1 capsule once daily with water' }],
    };
    store.writeRecord(patientId, med, doctorAbuja, { facilityId: 'facility-abuja-1', consent });

    // Fetch timeline
    const timeline = timelineEngine.getTimeline(patientId, doctorLagos, { consent });
    assert.equal(timeline.length, 2);

    // Chronological order: newest (Aug 2026) first, older (May 2026) second
    assert.equal(timeline[0].resourceType, 'MedicationStatement');
    assert.equal(timeline[1].resourceType, 'Condition');

    // Provenance statements
    assert.ok(timeline[0].provenance.badgeStatement.includes('National Hospital Abuja'));
    assert.ok(timeline[1].provenance.badgeStatement.includes('Lagos University Teaching Hospital'));

    // Filter by facility
    const abujaOnly = timelineEngine.getTimeline(patientId, doctorLagos, {
      consent,
      filters: { facilityId: 'facility-abuja-1' },
    });
    assert.equal(abujaOnly.length, 1);
    assert.equal(abujaOnly[0].resourceType, 'MedicationStatement');
  });
});

describe('4. Secure Document Upload & Antivirus Scanner', () => {
  const manager = new SecureDocumentManager();
  const patientId = 'patient-doc-upload';

  test('Valid PDF upload under 10MB passes scan and is encrypted into DocumentReference', async () => {
    const samplePdfBuffer = Buffer.from('%PDF-1.4 Mock Clinical Discharge Summary bytes for testing');
    const result = await manager.processUpload(
      {
        filename: 'discharge_summary.pdf',
        mimeType: 'application/pdf',
        buffer: samplePdfBuffer,
        title: 'Hospital Discharge Summary',
        category: 'discharge-summary',
      },
      patientId,
      'doc-uuid-1',
      'facility-lagos-1'
    );

    assert.equal(result.documentReference.resourceType, 'DocumentReference');
    assert.equal(result.documentReference.status, 'current');
    assert.equal(result.documentReference.content[0].attachment.contentType, 'application/pdf');
    assert.ok(result.encryptedFilePayload.includes(':'), 'Payload must be AES-GCM encrypted');
    assert.equal(result.sizeBytes, samplePdfBuffer.length);
  });

  test('Rejects files over 10MB limit', async () => {
    const hugeBuffer = Buffer.alloc(11 * 1024 * 1024); // 11MB
    await assert.rejects(async () => {
      await manager.processUpload(
        {
          filename: 'giant_scan.pdf',
          mimeType: 'application/pdf',
          buffer: hugeBuffer,
          title: 'Giant Scan',
          category: 'radiology-report',
        },
        patientId,
        'doc-uuid-1',
        'facility-lagos-1'
      );
    }, /exceeds 10MB limit/);
  });

  test('Antivirus scanner detects and blocks EICAR malware test string', async () => {
    const infectedBuffer = Buffer.from(`%PDF-1.4 harmless header ${EICAR_TEST_STRING} trailing bytes`);
    await assert.rejects(async () => {
      await manager.processUpload(
        {
          filename: 'malicious_attachment.pdf',
          mimeType: 'application/pdf',
          buffer: infectedBuffer,
          title: 'Infected Scan',
          category: 'laboratory-scan',
        },
        patientId,
        'doc-uuid-1',
        'facility-lagos-1'
      );
    }, /SECURITY ALERT: Virus or malicious payload detected/);
  });
});

describe('5. Record Export: HL7 FHIR Bundle & Readable Health Report', () => {
  const auditManager = new AuditChainManager();
  const store = new ClinicalDataStore(auditManager);
  const timelineEngine = new ClinicalTimelineEngine(store);
  const exportEngine = new RecordExportEngine(store, timelineEngine);
  const patientId = 'patient-uuid-export';

  const doctorActor: ActorContext = {
    userId: 'user-doc-1',
    role: 'DOCTOR',
    clinicianId: 'doc-uuid-1',
    facilityId: 'facility-lagos-1',
    isVerifiedClinician: true,
  };

  const consent: ConsentContext = {
    id: 'consent-export',
    patientId,
    scopes: ['all'],
    validUntil: new Date(Date.now() + 86400_000),
    isRevoked: false,
  };

  const patientEntity = createPatientRecord(
    { firstName: 'Amina', lastName: 'Bello', dateOfBirth: '1995-11-20', gender: 'female' },
    {
      bloodGroup: 'A_POSITIVE',
      genotype: 'AA',
      advanceDirectiveDnr: false,
      organDonor: true,
      allergies: [{ substance: 'Penicillin', category: 'medication' as any, reaction: 'Anaphylaxis', severity: 'severe' }],
      chronicConditions: ['Asthma'],
      emergencyContacts: [{ id: '1', name: 'Musa Bello', relationship: 'Father', phone: '+2348031234567', priority: 1 }],
    },
    { userId: patientId }
  );

  test('Exports standard HL7 FHIR R4 JSON Bundle', () => {
    // Write allergy
    const allergy: FHIRAllergyIntolerance = {
      resourceType: 'AllergyIntolerance',
      id: 'allergy-penicillin-1',
      clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] },
      verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: 'confirmed' }] },
      criticality: 'high',
      code: { text: 'Penicillin' },
      patient: { reference: `Patient/${patientId}` },
      recordedDate: '2026-09-01',
      recorder: { reference: 'Practitioner/doc-uuid-1' },
    };
    store.writeRecord(patientId, allergy, doctorActor, { facilityId: 'facility-lagos-1', consent });

    const bundle = exportEngine.exportFhirBundle(patientId, doctorActor, { consent });

    assert.equal(bundle.resourceType, 'Bundle');
    assert.equal(bundle.type, 'document');
    assert.equal(bundle.total, 1);
    assert.equal(bundle.entry[0].resource.resourceType, 'AllergyIntolerance');
  });

  test('Generates structured human-readable medical summary HTML report', () => {
    const reportHtml = exportEngine.exportHumanReadableReport(patientEntity, doctorActor, { consent });

    assert.ok(reportHtml.includes('MEDISTRY CLINICAL HEALTH SUMMARY'));
    assert.ok(reportHtml.includes('Amina Bello'));
    assert.ok(reportHtml.includes('A POSITIVE'));
    assert.ok(reportHtml.includes('AA'));
    assert.ok(reportHtml.includes('Penicillin'));
    assert.ok(reportHtml.includes('NDPA 2023 Compliant Health Export'));
  });
});

