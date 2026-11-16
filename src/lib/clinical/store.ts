/**
 * MEDISTRY Versioned Clinical Data Store & Write Engine
 * Enforces HL7 FHIR R4 shapes, immutability, versioning, AES-256-GCM encryption,
 * strict authorization policy checks, and tamper-evident audit logging.
 */

import crypto from 'node:crypto';
import { encryptField, decryptField } from '../patient/profile.ts';
import { evaluatePolicy, type ActorContext, type ConsentContext, type EmergencyGrantContext } from '../policy/enforcer.ts';
import { AuditChainManager } from '../audit/hashChain.ts';
import { deploymentCountry } from '../security/config.ts';
import type { RecordRepo } from '../data/repositories.ts';
import type {
  FHIREncounter,
  FHIRCondition,
  FHIRObservation,
  FHIRAllergyIntolerance,
  FHIRMedicationStatement,
  FHIRProcedure,
  FHIRDocumentReference,
  FHIRDiagnosticReport,
} from '../fhir/types.ts';

export type AnyClinicalFHIRResource =
  | FHIREncounter
  | FHIRCondition
  | FHIRObservation
  | FHIRAllergyIntolerance
  | FHIRMedicationStatement
  | FHIRProcedure
  | FHIRDocumentReference
  | FHIRDiagnosticReport;

// 'discarded': a draft the reviewing doctor rejected (kept, never shown, never signable).
export type RecordStatus = 'draft' | 'final' | 'discarded';
// 'emr-import': pushed by a facility system (Phase 15). 'ai-draft': proposed by the intake agent, signed by a doctor.
// 'pharmacy': a dispensing record written by a pharmacy (Phase 17).
export type RecordSource = 'clinician' | 'patient-reported' | 'emr-import' | 'ai-draft' | 'pharmacy';

/** Fired after a FINAL (doctor-signed) record is written, corrected or signed from a draft. Never for drafts. */
export interface FinalRecordEvent {
  record: StoredClinicalRecord;
  resource: AnyClinicalFHIRResource;
  previous?: { record: StoredClinicalRecord; resource: AnyClinicalFHIRResource };
  actor: ActorContext;
}

export interface StoredClinicalRecord {
  id: string;
  patientId: string;
  resourceType: string;
  versionId: number;
  isLatest: boolean;
  previousVersionId?: string;

  // Drafts (by nurses or records officers) stay invisible until a verified doctor signs them.
  status: RecordStatus;
  // 'patient-reported': the patient stated it (e.g. at onboarding); shown as not clinician-verified.
  source: RecordSource;
  draftedByUserId?: string;
  signedByClinicianId?: string;
  signedAt?: string;
  // Imports: SHA-256 of "<facilityId>|<resourceType>|<identifier system>|<identifier value>" (idempotent re-imports).
  externalKey?: string;
  // Lab results (Phase 17): the clinician who ordered the test (they are notified and see it in their results list).
  orderingClinicianId?: string;

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
  private finalListeners: Array<(event: FinalRecordEvent) => void> = [];
  /** Write-through repository (no-op in memory storage). */
  persistence?: RecordRepo;
  /** Patient ids merged into a survivor (Phase 16): their records count as the survivor's history too. */
  linkedPatientIds?: (patientId: string) => string[];

  constructor(auditManager: AuditChainManager) {
    this.auditManager = auditManager;
  }

  /** Rebuilds the working set from stored records (start-up). No audit entries, no listeners, no writes. */
  hydrate(records: StoredClinicalRecord[]): void {
    const ordered = [...records].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.versionId - b.versionId);
    for (const r of ordered) {
      this.records.set(r.id, r);
      this.indexRecord(r.patientId, r.id);
    }
  }

  /** Subscribes to doctor-signed records (used to keep the emergency card in step with the record). */
  onFinalRecord(listener: (event: FinalRecordEvent) => void): void {
    this.finalListeners.push(listener);
  }

  private emitFinal(event: FinalRecordEvent): void {
    for (const l of this.finalListeners) l(event);
  }

  private decrypt(record: StoredClinicalRecord): AnyClinicalFHIRResource {
    return JSON.parse(decryptField(record.encryptedPayload));
  }

  /** A doctor may only author records at the facility they are linked to. */
  private assertLinkedFacility(actor: ActorContext, facilityId: string, patientId: string, resourceType: string): void {
    if (actor.facilityId && actor.facilityId !== facilityId) {
      this.auditManager.appendEntry({
        actorId: actor.userId,
        subjectId: patientId,
        action: 'CLINICAL_WRITE_REJECTED',
        accessType: 'NORMAL_CONSENT',
        resourceType,
        facilityId,
        ipAddress: '127.0.0.1',
        userAgent: 'ClinicalClient/1.0',
        reason: 'Author is not linked to the facility the record is filed under',
      });
      throw new Error('Forbidden: author is not linked to this facility');
    }
  }

  /** Record ids for a patient, including records of patients merged into it (both histories, nothing moved). */
  private idsFor(patientId: string): string[] {
    return [patientId, ...(this.linkedPatientIds?.(patientId) || [])].flatMap((id) => this.patientIndex.get(id) || []);
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
      source?: RecordSource;
      /** Store as a draft even for a doctor (AI intake proposals wait for the doctor's review and signature). */
      forceDraft?: boolean;
    }
  ): { record: StoredClinicalRecord; resource: AnyClinicalFHIRResource } {
    // Nurses and records officers create drafts; only a verified doctor creates final records.
    const staffDraft = actor.role === 'NURSE' || actor.role === 'RECORDS_OFFICER';
    const isDraft = staffDraft || !!context.forceDraft;

    // A. Evaluate central authorization policy
    const policyDecision = evaluatePolicy({
      actor,
      action: staffDraft ? 'PATIENT_DRAFT_RECORD' : 'PATIENT_WRITE_RECORD',
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
    this.assertLinkedFacility(actor, context.facilityId, patientId, resource.resourceType);

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
      status: isDraft ? 'draft' : 'final',
      source: context.source || 'clinician',
      draftedByUserId: isDraft ? actor.userId : undefined,
      signedByClinicianId: isDraft ? undefined : actor.clinicianId || actor.userId,
      signedAt: isDraft ? undefined : now,
      authorClinicianId: actor.clinicianId || actor.userId,
      originFacilityId: context.facilityId,
      countryCode: context.countryCode || deploymentCountry(),
      clinicalCategory: context.category,
      effectiveDate: (resource as any).effectiveDateTime || (resource as any).recordedDate || now,
      encryptedPayload,
      payloadSignature,
      createdAt: now,
      updatedAt: now,
    };

    this.records.set(recordId, storedRecord);
    this.indexRecord(patientId, recordId);
    this.persistence?.saveRecord(storedRecord);

    // D. Append immutable audit row
    this.auditManager.appendEntry({
      actorId: actor.userId,
      subjectId: patientId,
      action: `${isDraft ? 'CLINICAL_RECORD_DRAFT' : 'CLINICAL_RECORD_WRITE'}_${resource.resourceType.toUpperCase()}`,
      accessType: 'NORMAL_CONSENT',
      resourceType: resource.resourceType,
      resourceId: recordId,
      facilityId: context.facilityId,
      countryCode: context.countryCode || deploymentCountry(),
      ipAddress: '127.0.0.1',
      userAgent: 'ClinicalClient/1.0',
      reason: isDraft ? 'Draft created; not visible until a doctor signs it' : 'Authoring initial clinical encounter resource',
    });

    if (!isDraft) this.emitFinal({ record: storedRecord, resource, actor });
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
    if (!existing.isLatest) throw new Error('Only the latest version of a record can be corrected');
    this.assertLinkedFacility(actor, context.facilityId, existing.patientId, existing.resourceType);
    const previousResource = this.decrypt(existing);

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
      status: 'final',
      source: existing.source,
      signedByClinicianId: actor.clinicianId || actor.userId,
      signedAt: now,
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
    this.persistence?.saveRecord(existing); // now isLatest = false
    this.persistence?.saveRecord(newVersionRecord);

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

    this.emitFinal({ record: newVersionRecord, resource: updatedResource, previous: { record: existing, resource: previousResource }, actor });
    return { record: newVersionRecord, resource: updatedResource };
  }

  /**
   * 2b. A verified doctor signs a draft. The draft is kept unchanged as the previous version and a new,
   * final version is created with the same content (nothing is overwritten or deleted).
   */
  signDraft(
    draftRecordId: string,
    actor: ActorContext,
    context: { consent?: ConsentContext | null; facilityId: string }
  ): { record: StoredClinicalRecord; resource: AnyClinicalFHIRResource } {
    const draft = this.records.get(draftRecordId);
    if (!draft) throw new Error(`Clinical record with ID ${draftRecordId} not found`);
    if (draft.status !== 'draft' || !draft.isLatest) throw new Error('Only the latest draft version can be signed');

    const decision = evaluatePolicy({
      actor,
      action: 'PATIENT_WRITE_RECORD',
      targetPatientId: draft.patientId,
      requestedResourceType: draft.resourceType,
      activeConsent: context.consent,
    });
    if (!decision.allowed) throw new Error(`Forbidden: ${decision.reason}`);
    this.assertLinkedFacility(actor, context.facilityId, draft.patientId, draft.resourceType);

    const resource = this.decrypt(draft);
    const now = new Date().toISOString();
    const signedId = crypto.randomUUID();
    resource.id = signedId;
    const json = JSON.stringify(resource);

    draft.isLatest = false;
    draft.updatedAt = now;
    const signed: StoredClinicalRecord = {
      ...draft,
      id: signedId,
      versionId: draft.versionId + 1,
      isLatest: true,
      previousVersionId: draft.id,
      status: 'final',
      signedByClinicianId: actor.clinicianId || actor.userId,
      signedAt: now,
      authorClinicianId: actor.clinicianId || actor.userId,
      encryptedPayload: encryptField(json),
      payloadSignature: crypto.createHash('sha256').update(json).digest('hex'),
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(signedId, signed);
    this.indexRecord(draft.patientId, signedId);
    this.persistence?.saveRecord(draft); // now isLatest = false
    this.persistence?.saveRecord(signed);

    this.auditManager.appendEntry({
      actorId: actor.userId,
      subjectId: draft.patientId,
      action: `CLINICAL_DRAFT_SIGNED_${draft.resourceType.toUpperCase()}`,
      accessType: 'NORMAL_CONSENT',
      resourceType: draft.resourceType,
      resourceId: signedId,
      facilityId: context.facilityId,
      countryCode: draft.countryCode,
      ipAddress: '127.0.0.1',
      userAgent: 'ClinicalClient/1.0',
      reason: `Draft ${draft.id} signed by doctor`,
    });

    this.emitFinal({ record: signed, resource, actor });
    return { record: signed, resource };
  }

  /**
   * A doctor edits a draft before signing: the edited content becomes a new draft version; the earlier draft is
   * kept unchanged. Same authorisation as signing.
   */
  reviseDraft(
    draftRecordId: string,
    resource: AnyClinicalFHIRResource,
    actor: ActorContext,
    context: { consent?: ConsentContext | null; facilityId: string }
  ): { record: StoredClinicalRecord; resource: AnyClinicalFHIRResource } {
    const draft = this.records.get(draftRecordId);
    if (!draft) throw new Error(`Clinical record with ID ${draftRecordId} not found`);
    if (draft.status !== 'draft' || !draft.isLatest) throw new Error('Only the latest draft version can be edited');
    if (resource.resourceType !== draft.resourceType) throw new Error('A draft cannot change its resource type');
    const decision = evaluatePolicy({ actor, action: 'PATIENT_WRITE_RECORD', targetPatientId: draft.patientId, requestedResourceType: draft.resourceType, activeConsent: context.consent });
    if (!decision.allowed) throw new Error(`Forbidden: ${decision.reason}`);
    this.assertLinkedFacility(actor, context.facilityId, draft.patientId, draft.resourceType);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    resource.id = id;
    const json = JSON.stringify(resource);
    draft.isLatest = false;
    draft.updatedAt = now;
    const revised: StoredClinicalRecord = {
      ...draft, id, versionId: draft.versionId + 1, isLatest: true, previousVersionId: draft.id,
      encryptedPayload: encryptField(json), payloadSignature: crypto.createHash('sha256').update(json).digest('hex'),
      effectiveDate: (resource as any).effectiveDateTime || (resource as any).recordedDate || draft.effectiveDate, createdAt: now, updatedAt: now,
    };
    this.records.set(id, revised);
    this.indexRecord(draft.patientId, id);
    this.persistence?.saveRecord(draft);
    this.persistence?.saveRecord(revised);
    this.auditManager.appendEntry({
      actorId: actor.userId, subjectId: draft.patientId, action: `CLINICAL_DRAFT_EDITED_${draft.resourceType.toUpperCase()}`,
      accessType: 'NORMAL_CONSENT', resourceType: draft.resourceType, resourceId: id, facilityId: context.facilityId, countryCode: draft.countryCode,
      ipAddress: '127.0.0.1', userAgent: 'ClinicalClient/1.0', reason: `Draft ${draft.id} edited before signing (v${revised.versionId})`,
    });
    return { record: revised, resource };
  }

  /** A doctor rejects a draft. It is kept (status 'discarded'), never shown and never signable. */
  discardDraft(draftRecordId: string, actor: ActorContext, context: { consent?: ConsentContext | null; facilityId: string; reason: string }): StoredClinicalRecord {
    const draft = this.records.get(draftRecordId);
    if (!draft) throw new Error(`Clinical record with ID ${draftRecordId} not found`);
    if (draft.status !== 'draft' || !draft.isLatest) throw new Error('Only the latest draft version can be discarded');
    const decision = evaluatePolicy({ actor, action: 'PATIENT_WRITE_RECORD', targetPatientId: draft.patientId, requestedResourceType: draft.resourceType, activeConsent: context.consent });
    if (!decision.allowed) throw new Error(`Forbidden: ${decision.reason}`);
    this.assertLinkedFacility(actor, context.facilityId, draft.patientId, draft.resourceType);
    draft.status = 'discarded';
    draft.updatedAt = new Date().toISOString();
    this.persistence?.saveRecord(draft);
    this.auditManager.appendEntry({
      actorId: actor.userId, subjectId: draft.patientId, action: `CLINICAL_DRAFT_DISCARDED_${draft.resourceType.toUpperCase()}`,
      accessType: 'NORMAL_CONSENT', resourceType: draft.resourceType, resourceId: draft.id, facilityId: context.facilityId,
      ipAddress: '127.0.0.1', userAgent: 'ClinicalClient/1.0', reason: `Draft discarded by the reviewing doctor: ${context.reason.slice(0, 200)}`,
    });
    return draft;
  }

  /** The latest version of an imported record, by its external key (idempotent imports). */
  findByExternalKey(externalKey: string): StoredClinicalRecord | undefined {
    for (const r of this.records.values()) if (r.externalKey === externalKey && r.isLatest) return r;
    return undefined;
  }

  /**
   * Writes a record pushed by an authorised facility system (FHIR import). The facility API client was authorised
   * by the caller. With a verified author linked to the facility the record is final (signed by that author);
   * otherwise it is a draft that a doctor must sign. A re-import with the same external key and content changes
   * nothing; with changed content it becomes a new version.
   */
  importRecord(
    patientId: string,
    resource: AnyClinicalFHIRResource,
    context: {
      facilityId: string; externalKey: string; authorClinicianId?: string; clientId: string; countryCode?: string; category?: string;
      /** A result reported by a registered laboratory: final without a clinician signature, linked to the orderer. */
      labResult?: { orderingClinicianId: string };
    }
  ): { record: StoredClinicalRecord; outcome: 'created' | 'updated' | 'unchanged' } {
    const json = JSON.stringify({ ...resource, id: undefined });
    const signature = crypto.createHash('sha256').update(json).digest('hex');
    const existing = this.findByExternalKey(context.externalKey);
    if (existing && existing.patientId !== patientId) throw new Error('This identifier is already used for another patient');
    if (existing) {
      const prev = this.decrypt(existing);
      const prevSig = crypto.createHash('sha256').update(JSON.stringify({ ...prev, id: undefined })).digest('hex');
      if (prevSig === signature) return { record: existing, outcome: 'unchanged' };
    }
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    resource.id = id;
    const stored = JSON.stringify(resource);
    const final = !!context.authorClinicianId || !!context.labResult;
    const record: StoredClinicalRecord = {
      id, patientId, resourceType: resource.resourceType,
      versionId: existing ? existing.versionId + 1 : 1, isLatest: true, previousVersionId: existing?.id,
      status: final ? 'final' : 'draft', source: 'emr-import',
      draftedByUserId: final ? undefined : `api-client:${context.clientId}`,
      signedByClinicianId: final ? context.authorClinicianId : undefined, signedAt: final ? now : undefined,
      authorClinicianId: context.authorClinicianId || (context.labResult ? `lab:${context.facilityId}` : `api-client:${context.clientId}`),
      ...(context.labResult ? { orderingClinicianId: context.labResult.orderingClinicianId } : {}),
      originFacilityId: context.facilityId, countryCode: context.countryCode || deploymentCountry(), clinicalCategory: context.category,
      effectiveDate: (resource as any).effectiveDateTime || (resource as any).recordedDate || (resource as any).period?.start || (resource as any).date || now,
      encryptedPayload: encryptField(stored), payloadSignature: crypto.createHash('sha256').update(stored).digest('hex'),
      externalKey: context.externalKey, createdAt: now, updatedAt: now,
    };
    if (existing) {
      existing.isLatest = false;
      existing.updatedAt = now;
      this.persistence?.saveRecord(existing);
    }
    this.records.set(id, record);
    this.indexRecord(patientId, id);
    this.persistence?.saveRecord(record);
    this.auditManager.appendEntry({
      actorId: `api-client:${context.clientId}`, subjectId: patientId,
      action: `CLINICAL_RECORD_IMPORTED_${resource.resourceType.toUpperCase()}`, accessType: 'NORMAL_CONSENT',
      resourceType: resource.resourceType, resourceId: id, facilityId: context.facilityId, countryCode: record.countryCode,
      ipAddress: '127.0.0.1', userAgent: 'FhirImport/1.0',
      reason: `${existing ? `Imported update (v${record.versionId})` : 'Imported'} from the facility system; ${context.labResult ? `laboratory result ordered by ${context.labResult.orderingClinicianId}` : final ? `signed by author ${context.authorClinicianId}` : 'no verified author: draft until a doctor signs it'}`,
    });
    if (final) {
      const previous = existing ? { record: existing, resource: this.decrypt(existing) } : undefined;
      this.emitFinal({ record, resource, previous, actor: { userId: `api-client:${context.clientId}`, role: 'DOCTOR', clinicianId: context.authorClinicianId, facilityId: context.facilityId, isVerifiedClinician: true } });
    }
    return { record, outcome: existing ? 'updated' : 'created' };
  }

  /**
   * A final record written by a non-clinical service that the caller has already authorised, e.g. a pharmacy's
   * MedicationDispense (Phase 17). It never changes another record.
   */
  writeServiceRecord(
    patientId: string,
    resource: AnyClinicalFHIRResource,
    context: { source: RecordSource; facilityId: string; authorId: string; action: string; reason: string }
  ): StoredClinicalRecord {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    resource.id = id;
    const json = JSON.stringify(resource);
    const record: StoredClinicalRecord = {
      id, patientId, resourceType: resource.resourceType, versionId: 1, isLatest: true, status: 'final', source: context.source,
      authorClinicianId: context.authorId, originFacilityId: context.facilityId, countryCode: deploymentCountry(),
      effectiveDate: (resource as any).whenHandedOver || (resource as any).effectiveDateTime || now,
      encryptedPayload: encryptField(json), payloadSignature: crypto.createHash('sha256').update(json).digest('hex'), createdAt: now, updatedAt: now,
    };
    this.records.set(id, record);
    this.indexRecord(patientId, id);
    this.persistence?.saveRecord(record);
    this.auditManager.appendEntry({
      actorId: context.authorId, subjectId: patientId, action: context.action, accessType: 'NORMAL_CONSENT', resourceType: resource.resourceType,
      resourceId: id, facilityId: context.facilityId, ipAddress: '127.0.0.1', userAgent: 'ServiceClient/1.0', reason: context.reason,
    });
    this.emitFinal({ record, resource, actor: { userId: context.authorId, role: 'PHARMACIST', facilityId: context.facilityId } as any });
    return record;
  }

  /** Lab results ordered by a clinician (latest versions), newest first. */
  resultsOrderedBy(clinicianId: string): StoredClinicalRecord[] {
    return [...this.records.values()].filter((r) => r.isLatest && r.status === 'final' && r.orderingClinicianId === clinicianId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Drafts waiting for a doctor's signature (for staff and doctors under consent; not shown to patients). */
  getDrafts(patientId: string, actor: ActorContext, consent?: ConsentContext | null): Array<{ record: StoredClinicalRecord; resource: AnyClinicalFHIRResource }> {
    const action = actor.role === 'DOCTOR' ? 'PATIENT_WRITE_RECORD' : 'PATIENT_DRAFT_RECORD';
    const decision = evaluatePolicy({ actor, action, targetPatientId: patientId, activeConsent: consent });
    if (!decision.allowed) throw new Error(`Forbidden: ${decision.reason}`);
    return this.idsFor(patientId)
      .map((id) => this.records.get(id)!)
      .filter((r) => r.status === 'draft' && r.isLatest)
      .map((record) => ({ record, resource: this.decrypt(record) }));
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

    const recordIds = this.idsFor(patientId);
    const results: Array<{ record: StoredClinicalRecord; resource: AnyClinicalFHIRResource }> = [];

    for (const id of recordIds) {
      const stored = this.records.get(id);
      if (!stored) continue;

      if (!context.includeHistoricalVersions && !stored.isLatest) {
        continue;
      }
      if (stored.status !== 'final') continue; // unsigned (or discarded) drafts are never part of the record view

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
   * 4b. Emergency full-history read. Requires an active break-glass grant that has been
   * co-signed by a second clinician (EMERGENCY_READ_FULL_HISTORY policy).
   */
  getPatientRecordsEmergency(
    patientId: string,
    actor: ActorContext,
    emergencyGrant: EmergencyGrantContext
  ): Array<{ record: StoredClinicalRecord; resource: AnyClinicalFHIRResource }> {
    const policyDecision = evaluatePolicy({
      actor,
      action: 'EMERGENCY_READ_FULL_HISTORY',
      targetPatientId: patientId,
      activeEmergencyGrant: emergencyGrant,
    });
    if (!policyDecision.allowed) {
      throw new Error(`Forbidden: ${policyDecision.reason}`);
    }
    if (emergencyGrant.patientId !== patientId) {
      throw new Error('Forbidden: Emergency grant does not belong to this patient');
    }

    const results: Array<{ record: StoredClinicalRecord; resource: AnyClinicalFHIRResource }> = [];
    for (const id of this.idsFor(patientId)) {
      const stored = this.records.get(id);
      if (!stored || !stored.isLatest || stored.status !== 'final') continue;
      results.push({ record: stored, resource: JSON.parse(decryptField(stored.encryptedPayload)) });
    }

    this.auditManager.appendEntry({
      actorId: actor.userId,
      subjectId: patientId,
      action: 'EMERGENCY_FULL_HISTORY_READ',
      accessType: 'EMERGENCY_BREAK_GLASS',
      facilityId: emergencyGrant.facilityId,
      ipAddress: '127.0.0.1',
      userAgent: 'ClinicalEmergencyPortal/1.0',
      reason: 'Full history read under dual co-signed emergency grant',
    });

    return results;
  }

  /**
   * Latest doctor-signed (final) versions of one resource type for a patient. No policy check or audit:
   * for callers that are already authorised (see clinical/encounters.ts). Drafts are never returned.
   */
  getLatestFinalRecords(patientId: string, resourceType: string): Array<{ record: StoredClinicalRecord; resource: AnyClinicalFHIRResource }> {
    return this.idsFor(patientId)
      .map((id) => this.records.get(id)!)
      .filter((r) => r && r.isLatest && r.status === 'final' && r.resourceType === resourceType)
      .map((record) => ({ record, resource: this.decrypt(record) }));
  }

  /**
   * Retrieve a single record by ID.
   */
  getRecordById(recordId: string): StoredClinicalRecord | undefined {
    return this.records.get(recordId);
  }
}

