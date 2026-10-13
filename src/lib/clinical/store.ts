/**
 * MEDISTRY Versioned Clinical Data Store & Write Engine
 * Enforces HL7 FHIR R4 shapes, immutability, versioning, AES-256-GCM encryption,
 * strict authorization policy checks, and tamper-evident audit logging.
 */

import crypto from 'node:crypto';
import { encryptField, decryptField } from '../patient/profile.ts';
import { evaluatePolicy, type ActorContext, type ConsentContext, type EmergencyGrantContext } from '../policy/enforcer.ts';
import { AuditChainManager } from '../audit/hashChain.ts';
import type {
  FHIREncounter,
  FHIRCondition,
  FHIRObservation,
  FHIRAllergyIntolerance,
  FHIRMedicationStatement,
  FHIRProcedure,
  FHIRDocumentReference,
} from '../fhir/types.ts';

export type AnyClinicalFHIRResource =
  | FHIREncounter
  | FHIRCondition
  | FHIRObservation
  | FHIRAllergyIntolerance
  | FHIRMedicationStatement
  | FHIRProcedure
  | FHIRDocumentReference;

export interface StoredClinicalRecord {
  id: string;
  patientId: string;
  resourceType: string;
  versionId: number;
  isLatest: boolean;
  previousVersionId?: string;

  // Origin & Federation
  authorClinicianId: string;
  originFacilityId: string;
  countryCode: string;

  // Encrypted Payload (AES-256-GCM)
  clinicalCategory?: string;
  effectiveDate: string;
  encryptedPayload: string;
  payloadSignature: string;

  createdAt: string;
  updatedAt: string;
}

export class ClinicalDataStore {
  private records = new Map<string, StoredClinicalRecord>(); // Key: recordId
  private patientIndex = new Map<string, string[]>();         // Key: patientId -> recordId[]
  private auditManager: AuditChainManager;

  constructor(auditManager: AuditChainManager) {
    this.auditManager = auditManager;
  }

  /**
   * Helper: Index a record under a patient
   */
  private indexRecord(patientId: string, recordId: string) {
    const list = this.patientIndex.get(patientId) || [];
    list.push(recordId);
    this.patientIndex.set(patientId, list);
  }

  /**
   * 1. Writes a new FHIR R4 clinical resource with authorization check and versioning.
   */
  writeRecord(
    patientId: string,
    resource: AnyClinicalFHIRResource,
    actor: ActorContext,
    context: {
      consent?: ConsentContext | null;
      emergencyGrant?: EmergencyGrantContext | null;
      facilityId: string;
      countryCode?: string;
      category?: string;
    }
  ): { record: StoredClinicalRecord; resource: AnyClinicalFHIRResource } {
    // A. Evaluate central authorization policy
    const policyDecision = evaluatePolicy({
      actor,
      action: 'PATIENT_WRITE_RECORD',
      targetPatientId: patientId,
      requestedResourceType: resource.resourceType,
      activeConsent: context.consent,
      activeEmergencyGrant: context.emergencyGrant,
    });

    if (!policyDecision.allowed) {
      this.auditManager.appendEntry({
        actorId: actor.userId,
        subjectId: patientId,
        action: 'CLINICAL_WRITE_REJECTED',
        accessType: 'NORMAL_CONSENT',
        resourceType: resource.resourceType,
        facilityId: context.facilityId,
        ipAddress: '127.0.0.1',
        userAgent: 'ClinicalClient/1.0',
        reason: policyDecision.reason,
      });
      throw new Error(`Forbidden: ${policyDecision.reason}`);
    }

    const now = new Date().toISOString();
    const recordId = resource.id || crypto.randomUUID();
    resource.id = recordId;

    // B. Serialize & Encrypt payload with AES-256-GCM
    const jsonString = JSON.stringify(resource);
    const encryptedPayload = encryptField(jsonString);
    const payloadSignature = crypto.createHash('sha256').update(jsonString).digest('hex');

    // C. Store initial version (versionId = 1, isLatest = true)
    const storedRecord: StoredClinicalRecord = {
      id: recordId,
      patientId,
      resourceType: resource.resourceType,
      versionId: 1,
      isLatest: true,
      authorClinicianId: actor.clinicianId || actor.userId,
      originFacilityId: context.facilityId,
      countryCode: context.countryCode || 'NG',
      clinicalCategory: context.category,
      effectiveDate: (resource as any).effectiveDateTime || (resource as any).recordedDate || now,
      encryptedPayload,
      payloadSignature,
      createdAt: now,
      updatedAt: now,
    };

    this.records.set(recordId, storedRecord);
    this.indexRecord(patientId, recordId);

    // D. Append immutable audit row
    this.auditManager.appendEntry({
      actorId: actor.userId,
      subjectId: patientId,
      action: `CLINICAL_RECORD_WRITE_${resource.resourceType.toUpperCase()}`,
      accessType: 'NORMAL_CONSENT',
      resourceType: resource.resourceType,
      resourceId: recordId,
      facilityId: context.facilityId,
      countryCode: context.countryCode || 'NG',
      ipAddress: '127.0.0.1',
      userAgent: 'ClinicalClient/1.0',
      reason: 'Authoring initial clinical encounter resource',
    });

    return { record: storedRecord, resource };
  }

  /**
   * 2. Updates an existing clinical record by creating a new version.
   * NEVER overwrites or hard-deletes previous versions.
   */
  updateRecord(
    existingRecordId: string,
    updatedResource: AnyClinicalFHIRResource,
    actor: ActorContext,
    context: {
      consent?: ConsentContext | null;
      emergencyGrant?: EmergencyGrantContext | null;
      facilityId: string;
      reason: string;
    }
  ): { record: StoredClinicalRecord; resource: AnyClinicalFHIRResource } {
    const existing = this.records.get(existingRecordId);
    if (!existing) {
      throw new Error(`Clinical record with ID ${existingRecordId} not found`);
    }

    // A. Evaluate central authorization policy
    const policyDecision = evaluatePolicy({
      actor,
      action: 'PATIENT_WRITE_RECORD',
      targetPatientId: existing.patientId,
      requestedResourceType: existing.resourceType,
      activeConsent: context.consent,
      activeEmergencyGrant: context.emergencyGrant,
    });

    if (!policyDecision.allowed) {
      throw new Error(`Forbidden: ${policyDecision.reason}`);
    }

    // B. Mark previous version as non-latest (archived/superseded)
    existing.isLatest = false;
    existing.updatedAt = new Date().toISOString();

    // C. Create new version with incremented versionId
    const now = new Date().toISOString();
    const newRecordId = crypto.randomUUID();
    updatedResource.id = newRecordId;

    const jsonString = JSON.stringify(updatedResource);
    const encryptedPayload = encryptField(jsonString);
    const payloadSignature = crypto.createHash('sha256').update(jsonString).digest('hex');

    const newVersionRecord: StoredClinicalRecord = {
      id: newRecordId,
      patientId: existing.patientId,
      resourceType: existing.resourceType,
      versionId: existing.versionId + 1,
      isLatest: true,
      previousVersionId: existing.id,
      authorClinicianId: actor.clinicianId || actor.userId,
      originFacilityId: context.facilityId,
      countryCode: existing.countryCode,
      clinicalCategory: existing.clinicalCategory,
      effectiveDate: now,
      encryptedPayload,
      payloadSignature,
      createdAt: now,
      updatedAt: now,
    };

    this.records.set(newRecordId, newVersionRecord);
    this.indexRecord(existing.patientId, newRecordId);

    // D. Log immutable audit entry for version update
    this.auditManager.appendEntry({
      actorId: actor.userId,
      subjectId: existing.patientId,
      action: `CLINICAL_RECORD_VERSION_UPDATE_${existing.resourceType.toUpperCase()}`,
      accessType: 'NORMAL_CONSENT',
      resourceType: existing.resourceType,
      resourceId: newRecordId,
      facilityId: context.facilityId,
      countryCode: existing.countryCode,
      ipAddress: '127.0.0.1',
      userAgent: 'ClinicalClient/1.0',
      reason: `Version update (v${newVersionRecord.versionId}): ${context.reason}`,
    });

    return { record: newVersionRecord, resource: updatedResource };
  }

  /**
   * 3. Hard-delete safeguard: Clinical records can NEVER be hard-deleted.
   */
  deleteRecord(): never {
    throw new Error('ERR_HARD_DELETE_PROHIBITED: Clinical records are immutable and cannot be hard-deleted under HL7 FHIR and NDPA regulations');
  }

  /**
   * 4. Reads and decrypts all latest clinical resources for a patient.
   */
  getPatientRecords(
    patientId: string,
    actor: ActorContext,
    context: {
      consent?: ConsentContext | null;
      emergencyGrant?: EmergencyGrantContext | null;
      includeHistoricalVersions?: boolean;
    }
  ): Array<{ record: StoredClinicalRecord; resource: AnyClinicalFHIRResource }> {
    // Policy check
    const policyDecision = evaluatePolicy({
      actor,
      action: 'PATIENT_READ_RECORD',
      targetPatientId: patientId,
      activeConsent: context.consent,
      activeEmergencyGrant: context.emergencyGrant,
    });

    if (!policyDecision.allowed) {
      throw new Error(`Forbidden: ${policyDecision.reason}`);
    }

    const recordIds = this.patientIndex.get(patientId) || [];
    const results: Array<{ record: StoredClinicalRecord; resource: AnyClinicalFHIRResource }> = [];

    for (const id of recordIds) {
      const stored = this.records.get(id);
      if (!stored) continue;

      if (!context.includeHistoricalVersions && !stored.isLatest) {
        continue;
      }

      // Decrypt AES-256-GCM payload
      const decryptedJson = decryptField(stored.encryptedPayload);
      const resource = JSON.parse(decryptedJson);

      results.push({ record: stored, resource });
    }

    // Log read audit event
    this.auditManager.appendEntry({
      actorId: actor.userId,
      subjectId: patientId,
      action: 'CLINICAL_RECORDS_READ_BATCH',
      accessType: 'NORMAL_CONSENT',
      ipAddress: '127.0.0.1',
      userAgent: 'ClinicalClient/1.0',
      reason: 'Reading patient health record timeline',
    });

    return results;
  }

  /**
   * Retrieve a single record by ID.
   */
  getRecordById(recordId: string): StoredClinicalRecord | undefined {
    return this.records.get(recordId);
  }
}

