/**
 * FHIR R4 import (Phase 15): a facility's EMR pushes a Bundle (transaction or collection) and Medistry files the
 * records, so nobody types them in twice.
 *
 * All or nothing: every entry is validated first; any error rejects the whole bundle with an OperationOutcome and
 * nothing is written. Supported: Encounter, Condition, AllergyIntolerance, MedicationStatement, Observation,
 * DiagnosticReport, DocumentReference. Patient entries are used for matching only (a patient is never created
 * from an import) and Practitioner entries only to identify the author.
 *
 * Patient matching: an identifier with system MEDISTRY_PATIENT_ID_SYSTEM and the Medistry patient id, or a facility
 * identifier (e.g. the facility's MRN) linked to the patient by an earlier matched import. A birthDate that
 * disagrees with the record rejects the bundle. The facility must already be connected to the patient: primary
 * facility, an active consent grant to the facility, or an earlier matched import. TODO (Phase 16): fuller
 * identity matching.
 *
 * Authors: a Practitioner (by Medistry clinician id, or an identifier equal to the clinician's licence number)
 * who is VERIFIED and works at the importing facility makes the record final, signed by them. Otherwise the record
 * is a draft that a doctor must sign (Phase 6); drafts never reach the emergency summary or the card.
 *
 * Idempotent: each record's key is (facility, resource type, identifier system, identifier value), falling back
 * to the source resource id. Re-importing the same content changes nothing; changed content becomes a new version.
 */
import type { AnyClinicalFHIRResource, ClinicalDataStore } from '../clinical/store.ts';
import type { PatientEntity } from '../patient/profile.ts';
import { decryptPatientDemographics, encryptField } from '../patient/profile.ts';
import type { SeedClinician } from '../../../prisma/seed.ts';
import type { ConsentLifecycleManager } from '../consent/consentManager.ts';
import type { AuditChainManager } from '../audit/hashChain.ts';
import type { SecureDocumentManager } from '../clinical/fileUpload.ts';
import crypto from 'node:crypto';
import { keyProvider } from '../crypto/keyProvider.ts';
import type { IdentityStore } from '../identity/identityStore.ts';
import { REVIEW_THRESHOLD, type MasterPatientIndex } from '../identity/mpi.ts';
import type { SeedFacility } from '../../../prisma/seed.ts';
import type { NotificationDispatcher } from '../notifications/dispatcher.ts';
import type { AccountStore } from '../auth/accounts.ts';

/**
 * FHIR identifier systems for national identifiers (Phase 16): Medistry's own namespace by default
 * ("urn:medistry:id:<country>:<idType>", e.g. urn:medistry:id:NG:NIN), plus aliases from
 * IDENTITY_FHIR_SYSTEMS ("<system uri>=<country>:<idType>,..."). No official system URIs are assumed.
 */
export function nationalIdentifierFor(system: string, env: NodeJS.ProcessEnv = process.env): { country: string; idType: string } | null {
  const own = /^urn:medistry:id:([A-Z]{2}):([A-Z_]{2,20})$/.exec(system);
  if (own) return { country: own[1], idType: own[2] };
  for (const pair of (env.IDENTITY_FHIR_SYSTEMS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const at = pair.lastIndexOf('=');
    const [country, idType] = pair.slice(at + 1).split(':');
    if (at > 0 && pair.slice(0, at) === system && country && idType) return { country: country.toUpperCase(), idType: idType.toUpperCase() };
  }
  return null;
}

/**
 * Keyed hash of a facility identifier (e.g. an MRN) for lookups, under a field key version (default current).
 * Lookups try every readable version, so a field key rotation does not break matching.
 */
export function facilityIdentifierHash(facilityId: string, system: string, value: string, version?: number): string {
  const { key } = keyProvider().getFieldEncryptionKey(version);
  return crypto.createHmac('sha256', key).update(`medistry-facility-identifier:${facilityId}|${system}|${value}`).digest('hex');
}

/** Import keys are stored hashed (they contain source identifiers); equality is all that is needed. */
export const importKeyHash = (facilityId: string, resourceType: string, keyPart: string) =>
  crypto.createHash('sha256').update(`${facilityId}|${resourceType}|${keyPart}`).digest('hex');

export const MEDISTRY_PATIENT_ID_SYSTEM = 'urn:medistry:patient-id';
export const SUPPORTED_IMPORT_TYPES = ['Encounter', 'Condition', 'AllergyIntolerance', 'MedicationStatement', 'Observation', 'DiagnosticReport', 'DocumentReference'] as const;
export const MAX_BUNDLE_ENTRIES = 500;

// FHIR R4 required status value sets.
const STATUS: Record<string, string[]> = {
  Encounter: ['planned', 'arrived', 'triaged', 'in-progress', 'onleave', 'finished', 'cancelled', 'entered-in-error', 'unknown'],
  Observation: ['registered', 'preliminary', 'final', 'amended', 'corrected', 'cancelled', 'entered-in-error', 'unknown'],
  DiagnosticReport: ['registered', 'partial', 'preliminary', 'final', 'amended', 'corrected', 'appended', 'cancelled', 'entered-in-error', 'unknown'],
  MedicationStatement: ['active', 'completed', 'entered-in-error', 'intended', 'stopped', 'on-hold', 'unknown', 'not-taken'],
  DocumentReference: ['current', 'superseded', 'entered-in-error'],
};
// Code formats for well-known systems (checked only when that system is used).
const CODE_FORMATS: Record<string, RegExp> = {
  'http://loinc.org': /^\d{1,7}-\d$/,
  'http://snomed.info/sct': /^\d{6,18}$/,
  'http://hl7.org/fhir/sid/icd-10': /^[A-Z]\d{2}(\.[0-9A-Z]{1,4})?$/i,
  'http://hl7.org/fhir/sid/icd-10-cm': /^[A-Z]\d{2}(\.[0-9A-Z]{1,4})?$/i,
};
const FHIR_DATE = /^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?)?)?$/;

export interface OperationOutcomeIssue {
  severity: 'error' | 'warning';
  code: 'invalid' | 'required' | 'value' | 'not-found' | 'not-supported' | 'duplicate' | 'forbidden' | 'processing';
  diagnostics: string;
  expression?: string[];
}
export interface OperationOutcome { resourceType: 'OperationOutcome'; issue: OperationOutcomeIssue[] }

export class FhirImportError extends Error {
  status: number;
  outcome: OperationOutcome;
  constructor(status: number, issues: OperationOutcomeIssue[]) {
    super(issues[0]?.diagnostics || 'Import rejected');
    this.status = status;
    this.outcome = { resourceType: 'OperationOutcome', issue: issues };
  }
}

/** A facility identifier known to belong to a patient. Stored as a keyed hash plus an encrypted copy (for re-hashing). */
export interface FacilityPatientLink { facilityId: string; system: string; valueHash: string; encryptedValue: string; patientId: string; createdAt: string }
export interface FacilityPatientLinkRepo { saveFacilityPatientLink(l: FacilityPatientLink): void }

/** Facility identifiers (MRNs) known to belong to a Medistry patient, learnt from matched imports. */
export class FacilityPatientLinkStore {
  private links = new Map<string, FacilityPatientLink>(); // valueHash -> link
  persistence?: FacilityPatientLinkRepo;
  hydrate(rows: FacilityPatientLink[]): void { for (const l of rows) this.links.set(l.valueHash, l); }
  find(facilityId: string, system: string, value: string): string | undefined {
    for (const v of keyProvider().getFieldKeyVersions()) {
      const hit = this.links.get(facilityIdentifierHash(facilityId, system, value, v));
      if (hit) return hit.patientId;
    }
    return undefined;
  }
  hasFacility(facilityId: string, patientId: string): boolean {
    for (const l of this.links.values()) if (l.facilityId === facilityId && l.patientId === patientId) return true;
    return false;
  }
  add(facilityId: string, system: string, value: string, patientId: string): void {
    if (this.find(facilityId, system, value)) return;
    const l: FacilityPatientLink = {
      facilityId, system: system.slice(0, 200), valueHash: facilityIdentifierHash(facilityId, system, value),
      encryptedValue: encryptField(value), patientId, createdAt: new Date().toISOString(),
    };
    this.links.set(l.valueHash, l);
    this.persistence?.saveFacilityPatientLink(l);
  }
  all(): FacilityPatientLink[] { return [...this.links.values()]; }
}

export interface ImportClient { id: string; clientId: string; facilityId: string }

export interface ImportResult {
  response: { resourceType: 'Bundle'; type: 'transaction-response'; entry: Array<{ response: { status: string; location: string; outcome?: OperationOutcome } }> };
  summary: { created: number; updated: number; unchanged: number; drafts: number };
}

const text = (cc: any): string | undefined => (typeof cc?.text === 'string' && cc.text.trim()) || cc?.coding?.find((c: any) => c?.display)?.display || cc?.coding?.[0]?.code;
const refId = (ref: any): string | undefined => (typeof ref?.reference === 'string' ? ref.reference : undefined);

export class FhirImportService {
  private deps: {
    clinicalStore: ClinicalDataStore; patientsById: Map<string, PatientEntity>; clinicians: SeedClinician[];
    consentManager: ConsentLifecycleManager; auditManager: AuditChainManager; links: FacilityPatientLinkStore; documents: SecureDocumentManager;
    identity?: IdentityStore; mpi?: MasterPatientIndex;
    // Phase 17: facility kinds (labs, pharmacies) and result notifications
    facilities?: SeedFacility[]; dispatcher?: NotificationDispatcher; accounts?: AccountStore;
  };

  constructor(deps: FhirImportService['deps']) {
    this.deps = deps;
  }

  private facilityConnected(facilityId: string, patient: PatientEntity): boolean {
    if (patient.primaryFacilityId === facilityId || this.deps.links.hasFacility(facilityId, patient.id)) return true;
    const now = Date.now();
    // Only full-record consents count (a pharmacy's medications-only consent does not let it file records).
    return this.deps.consentManager.getPatientConsents(patient.id).some((g) => !g.isRevoked && new Date(g.validUntil).getTime() > now && g.targetFacilityId === facilityId && g.scopes.includes('all'));
  }

  private checkCodings(cc: any, where: string, issues: OperationOutcomeIssue[]): void {
    for (const [i, c] of (Array.isArray(cc?.coding) ? cc.coding : []).entries()) {
      const at = `${where}.coding[${i}]`;
      if (c?.system !== undefined && (typeof c.system !== 'string' || !/^(https?:\/\/|urn:)\S+$/.test(c.system))) {
        issues.push({ severity: 'error', code: 'value', diagnostics: 'coding.system must be an absolute URI', expression: [`${at}.system`] });
      }
      if (typeof c?.code !== 'string' || !c.code.trim() || c.code.length > 100) {
        issues.push({ severity: 'error', code: 'required', diagnostics: 'coding.code is required', expression: [`${at}.code`] });
      } else if (CODE_FORMATS[c.system] && !CODE_FORMATS[c.system].test(c.code)) {
        issues.push({ severity: 'error', code: 'value', diagnostics: `"${c.code.slice(0, 20)}" is not a valid code for ${c.system}`, expression: [`${at}.code`] });
      }
    }
  }

  private requireConcept(cc: any, where: string, issues: OperationOutcomeIssue[]): void {
    if (!text(cc)) issues.push({ severity: 'error', code: 'required', diagnostics: `${where} needs text or a coding`, expression: [where] });
    else this.checkCodings(cc, where, issues);
  }

  private checkDate(v: unknown, where: string, issues: OperationOutcomeIssue[]): void {
    if (v !== undefined && (typeof v !== 'string' || !FHIR_DATE.test(v))) issues.push({ severity: 'error', code: 'value', diagnostics: `${where} is not a FHIR date/dateTime`, expression: [where] });
  }

  /** Required fields and value checks for one clinical resource. */
  private validate(r: any, at: string, issues: OperationOutcomeIssue[]): void {
    const t = r.resourceType;
    if (STATUS[t] && !STATUS[t].includes(r.status)) {
      issues.push({ severity: 'error', code: r.status ? 'value' : 'required', diagnostics: `${t}.status must be one of ${STATUS[t].join(', ')}`, expression: [`${at}.status`] });
    }
    const subjectField = t === 'AllergyIntolerance' ? 'patient' : 'subject';
    if (!refId(r[subjectField])) issues.push({ severity: 'error', code: 'required', diagnostics: `${t}.${subjectField} is required`, expression: [`${at}.${subjectField}`] });
    switch (t) {
      case 'Encounter':
        if (typeof r.class?.code !== 'string' || !r.class.code) issues.push({ severity: 'error', code: 'required', diagnostics: 'Encounter.class.code is required', expression: [`${at}.class`] });
        this.checkDate(r.period?.start, `${at}.period.start`, issues);
        for (const [i, rc] of (r.reasonCode || []).entries()) this.checkCodings(rc, `${at}.reasonCode[${i}]`, issues);
        break;
      case 'Condition':
        this.requireConcept(r.code, `${at}.code`, issues);
        this.checkDate(r.recordedDate, `${at}.recordedDate`, issues);
        break;
      case 'AllergyIntolerance':
        this.requireConcept(r.code, `${at}.code`, issues);
        if (r.criticality !== undefined && !['low', 'high', 'unable-to-assess'].includes(r.criticality)) issues.push({ severity: 'error', code: 'value', diagnostics: 'AllergyIntolerance.criticality must be low, high or unable-to-assess', expression: [`${at}.criticality`] });
        break;
      case 'MedicationStatement':
        this.requireConcept(r.medicationCodeableConcept, `${at}.medicationCodeableConcept`, issues);
        break;
      case 'Observation':
      case 'DiagnosticReport':
        this.requireConcept(r.code, `${at}.code`, issues);
        this.checkDate(r.effectiveDateTime, `${at}.effectiveDateTime`, issues);
        break;
      case 'DocumentReference':
        if (typeof r.content?.[0]?.attachment?.contentType !== 'string') issues.push({ severity: 'error', code: 'required', diagnostics: 'DocumentReference.content[0].attachment.contentType is required', expression: [`${at}.content`] });
        break;
    }
  }

  /** Fills the display fields the timeline and card read (code.text and similar) from codings. */
  private normalise(r: any): any {
    const fill = (cc: any) => (cc && !cc.text ? { ...cc, text: text(cc) } : cc);
    if (r.code) r.code = fill(r.code);
    if (r.medicationCodeableConcept) r.medicationCodeableConcept = fill(r.medicationCodeableConcept);
    if (r.resourceType === 'Encounter' && r.class && !r.class.display) r.class = { ...r.class, display: r.class.code };
    if (r.resourceType === 'AllergyIntolerance' && !r.criticality) r.criticality = 'unable-to-assess';
    if (r.resourceType === 'DocumentReference' && !text(r.type)) r.type = { text: 'Imported document' };
    if (r.resourceType === 'DocumentReference' && r.type && !r.type.text) r.type = fill(r.type);
    return r;
  }

  private authorRefs(r: any): string[] {
    const refs: any[] = [];
    switch (r.resourceType) {
      case 'Encounter': refs.push(...(r.participant || []).map((p: any) => p?.individual)); break;
      case 'Condition': case 'AllergyIntolerance': refs.push(r.recorder, r.asserter); break;
      case 'Observation': refs.push(...(r.performer || [])); break;
      case 'MedicationStatement': refs.push(r.informationSource); break;
      case 'DiagnosticReport': refs.push(...(r.resultsInterpreter || []), ...(r.performer || [])); break;
      case 'DocumentReference': refs.push(...(r.author || [])); break;
    }
    return refs.map(refId).filter((x): x is string => !!x && (x.startsWith('Practitioner/') || x.startsWith('urn:')));
  }

  /**
   * Lab results are ready: the patient gets an SMS (template, no result content) and an app notification; the
   * ordering clinician gets an app notification. Once per patient per bundle. Audited without content.
   */
  private async notifyResults(results: Map<string, string[]>, client: ImportClient, info: { ipAddress: string; userAgent: string }): Promise<void> {
    const { dispatcher, accounts } = this.deps;
    if (!dispatcher) return;
    for (const [patientId, orderers] of results) {
      const patient = this.deps.patientsById.get(patientId);
      const account = accounts?.byPatient(patientId);
      const phone = account ? accounts!.phoneOf(account) : undefined;
      if (phone) await dispatcher.sendSms(phone, { template: 'lab_result_ready', locale: patient?.preferredLocale });
      await dispatcher.notifyUser(patientId, 'Result ready', 'A new result is in your Medistry record.');
      for (const id of new Set(orderers)) {
        const c = this.deps.clinicians.find((x) => x.id === id);
        if (c) await dispatcher.notifyUser(c.userId, 'Lab result ready', 'A result you ordered has arrived. Open your results list in Medistry.');
      }
      this.deps.auditManager.appendEntry({
        actorId: `api-client:${client.clientId}`, subjectId: patientId, action: 'LAB_RESULT_NOTIFIED', accessType: 'SYSTEM_ADMIN', facilityId: client.facilityId,
        ipAddress: info.ipAddress, userAgent: info.userAgent, reason: `Patient told a result is ready (${phone ? 'SMS and app' : 'app'}; no result content); ordering clinician notified`,
      });
    }
  }

  async importBundle(bundle: any, client: ImportClient, info: { ipAddress: string; userAgent: string }): Promise<ImportResult> {
    const issues: OperationOutcomeIssue[] = [];
    const reject = (status: number) => {
      this.deps.auditManager.appendEntry({
        actorId: `api-client:${client.clientId}`, action: 'FHIR_BUNDLE_REJECTED', accessType: 'SYSTEM_ADMIN', facilityId: client.facilityId,
        ipAddress: info.ipAddress, userAgent: info.userAgent, reason: `Bundle rejected with ${issues.length} issue(s); nothing was saved`,
      });
      return new FhirImportError(status, issues);
    };
    if (bundle?.resourceType !== 'Bundle' || !['transaction', 'collection'].includes(bundle?.type)) {
      issues.push({ severity: 'error', code: 'invalid', diagnostics: 'Expected a FHIR R4 Bundle of type transaction or collection', expression: ['Bundle.type'] });
      throw reject(400);
    }
    // Phase 17: labs submit results only; pharmacies never import (they record dispensing through /api/pharmacy).
    const kind = this.deps.facilities?.find((f) => f.id === client.facilityId)?.kind || 'HOSPITAL';
    if (kind === 'PHARMACY') {
      issues.push({ severity: 'error', code: 'forbidden', diagnostics: 'Pharmacies cannot import records; dispensing is recorded through the pharmacy API', expression: ['Bundle'] });
      throw reject(403);
    }
    const entries: any[] = Array.isArray(bundle.entry) ? bundle.entry : [];
    if (!entries.length || entries.length > MAX_BUNDLE_ENTRIES) {
      issues.push({ severity: 'error', code: 'invalid', diagnostics: `A bundle must have 1 to ${MAX_BUNDLE_ENTRIES} entries`, expression: ['Bundle.entry'] });
      throw reject(400);
    }

    // Pass 1a: Patient and Practitioner entries (matching only, nothing stored for them).
    const patientRefs = new Map<string, string>();      // "Patient/x" or fullUrl -> Medistry patient id
    const practitionerRefs = new Map<string, SeedClinician | null>();
    const pendingLinks: Array<{ system: string; value: string; patientId: string }> = [];
    entries.forEach((e, i) => {
      const r = e?.resource;
      const at = `Bundle.entry[${i}].resource`;
      if (r?.resourceType === 'Patient') {
        const ids: any[] = Array.isArray(r.identifier) ? r.identifier.filter((x: any) => typeof x?.system === 'string' && typeof x?.value === 'string') : [];
        const matches = new Set<string>();
        for (const id of ids) {
          const national = nationalIdentifierFor(id.system);
          const m = id.system === MEDISTRY_PATIENT_ID_SYSTEM ? (this.deps.patientsById.has(id.value) ? id.value : undefined)
            : national ? this.deps.identity?.findPatient(national.country, national.idType, id.value) // blind index, exact match
            : this.deps.links.find(client.facilityId, id.system, id.value);
          if (m) matches.add(this.deps.mpi ? this.deps.mpi.canonical(m) : m);
        }
        if (matches.size !== 1) {
          // No exact match: probable matches are reported (never used to file records, never auto-linked).
          let probable = 0;
          if (!matches.size && this.deps.mpi && r.birthDate) {
            const name = [...(r.name?.[0]?.given || []), r.name?.[0]?.family].filter(Boolean).join(' ') || r.name?.[0]?.text || '';
            const phone = (r.telecom || []).find((t: any) => t?.system === 'phone')?.value;
            probable = this.deps.mpi.findCandidates({ name, dob: r.birthDate, gender: r.gender, phone: phone ? String(phone).replace(/[\s().-]/g, '') : undefined })
              .filter((c) => c.score >= REVIEW_THRESHOLD).length;
          }
          issues.push({
            severity: 'error', code: matches.size ? 'duplicate' : 'not-found', expression: [`${at}.identifier`],
            diagnostics: matches.size ? 'Patient identifiers match more than one Medistry patient'
              : `No identity match for this Patient. Medistry never creates patients from imports; link the patient first.${probable ? ` ${probable} probable match(es) exist: a records officer must confirm the identity (for example by adding a national identifier).` : ''}`,
          });
          return;
        }
        const patientId = [...matches][0];
        const patient = this.deps.patientsById.get(patientId)!;
        if (r.birthDate && r.birthDate !== decryptPatientDemographics(patient).dateOfBirth) {
          issues.push({ severity: 'error', code: 'value', diagnostics: 'Patient.birthDate does not match the matched record (identity check failed)', expression: [`${at}.birthDate`] });
          return;
        }
        if (r.id) patientRefs.set(`Patient/${r.id}`, patientId);
        if (e.fullUrl) patientRefs.set(e.fullUrl, patientId);
        for (const id of ids) if (id.system !== MEDISTRY_PATIENT_ID_SYSTEM) pendingLinks.push({ system: id.system, value: id.value, patientId });
      } else if (r?.resourceType === 'Practitioner') {
        const licences = (Array.isArray(r.identifier) ? r.identifier : []).map((x: any) => String(x?.value || '').trim().toUpperCase());
        const c = this.deps.clinicians.find((x) => x.id === r.id || licences.includes(x.licenseNumber.toUpperCase())) || null;
        if (r.id) practitionerRefs.set(`Practitioner/${r.id}`, c);
        if (e.fullUrl) practitionerRefs.set(e.fullUrl, c);
      }
    });

    // Pass 1a+: ServiceRequest entries (link only): who ordered a lab test.
    const orders = new Map<string, SeedClinician | null>();
    entries.forEach((e) => {
      const r = e?.resource;
      if (r?.resourceType !== 'ServiceRequest') return;
      const ref = refId(r.requester);
      const c = ref ? (practitionerRefs.get(ref) ?? this.deps.clinicians.find((x) => `Practitioner/${x.id}` === ref) ?? null) : null;
      if (r.id) orders.set(`ServiceRequest/${r.id}`, c);
      if (e.fullUrl) orders.set(e.fullUrl, c);
    });

    // Pass 1b: clinical entries.
    type Planned = { resource: any; patientId: string; externalKey: string; authorClinicianId?: string; category?: string; orderingClinicianId?: string };
    const planned: Planned[] = [];
    const keys = new Set<string>();
    for (const [i, e] of entries.entries()) {
      const r = e?.resource;
      const at = `Bundle.entry[${i}].resource`;
      if (!r || typeof r !== 'object') { issues.push({ severity: 'error', code: 'required', diagnostics: 'Entry without a resource', expression: [`Bundle.entry[${i}]`] }); continue; }
      if (r.resourceType === 'Patient' || r.resourceType === 'Practitioner' || r.resourceType === 'ServiceRequest') continue;
      if (kind === 'LAB' && r.resourceType !== 'DiagnosticReport' && r.resourceType !== 'Observation') {
        issues.push({ severity: 'error', code: 'not-supported', diagnostics: 'Laboratories submit DiagnosticReport and Observation only', expression: [at] });
        continue;
      }
      if (!SUPPORTED_IMPORT_TYPES.includes(r.resourceType)) {
        issues.push({ severity: 'error', code: 'not-supported', diagnostics: `${String(r.resourceType).slice(0, 40)} is not supported for import`, expression: [at] });
        continue;
      }
      const before = issues.length;
      this.validate(r, at, issues);
      const subject = refId(r.resourceType === 'AllergyIntolerance' ? r.patient : r.subject);
      let patientId = subject ? patientRefs.get(subject) : undefined;
      if (!patientId && subject?.startsWith('Patient/') && this.deps.patientsById.has(subject.slice(8))) patientId = subject.slice(8);
      const patient = patientId ? this.deps.patientsById.get(patientId) : undefined;
      // Lab results must name the verified clinician who ordered them (basedOn a ServiceRequest with a requester).
      const orderer = kind === 'LAB'
        ? (Array.isArray(r.basedOn) ? r.basedOn : []).map((b: any) => orders.get(refId(b) || '')).find((c: SeedClinician | null | undefined) => c && c.status === 'VERIFIED')
        : undefined;
      if (kind === 'LAB' && !orderer) {
        issues.push({ severity: 'error', code: 'required', diagnostics: 'A lab result must reference its order (basedOn a ServiceRequest whose requester is a verified Medistry clinician)', expression: [`${at}.basedOn`] });
      }
      // A lab is connected through the ordering clinician's active consent for this patient.
      const labConnected = !!(orderer && patient && this.deps.consentManager.resolveActiveConsent(patient.id, orderer.id, orderer.facilityId));
      if (subject && !patient) {
        issues.push({ severity: 'error', code: 'not-found', diagnostics: 'The subject does not match a Medistry patient (patients are never created from imports)', expression: [`${at}.${r.resourceType === 'AllergyIntolerance' ? 'patient' : 'subject'}`] });
      } else if (patient && !labConnected && !this.facilityConnected(client.facilityId, patient) && !pendingLinks.some((l) => l.patientId === patient.id)) {
        issues.push({ severity: 'error', code: 'forbidden', diagnostics: 'This facility is not connected to the patient (no primary facility, consent or earlier import)', expression: [at] });
      }
      const ident = (Array.isArray(r.identifier) ? r.identifier : []).find((x: any) => typeof x?.value === 'string' && x.value);
      const keyPart = ident ? `${ident.system || ''}|${ident.value}` : (typeof r.id === 'string' && r.id ? `id|${r.id}` : '');
      if (!keyPart) issues.push({ severity: 'error', code: 'required', diagnostics: 'Each resource needs an identifier or id (for idempotent re-imports)', expression: [`${at}.identifier`] });
      const externalKey = importKeyHash(client.facilityId, r.resourceType, keyPart);
      if (keyPart && keys.has(externalKey)) issues.push({ severity: 'error', code: 'duplicate', diagnostics: 'The same resource appears twice in this bundle', expression: [`${at}.identifier`] });
      keys.add(externalKey);
      const existing = this.deps.clinicalStore.findByExternalKey(externalKey);
      if (existing && patient && existing.patientId !== patient.id) issues.push({ severity: 'error', code: 'duplicate', diagnostics: 'This identifier was already imported for another patient', expression: [`${at}.identifier`] });
      // Inline attachment data: same checks as any upload (size, magic bytes, malware scan).
      const data = r.resourceType === 'DocumentReference' ? r.content?.[0]?.attachment?.data : undefined;
      if (typeof data === 'string' && patient) {
        try {
          await this.deps.documents.processUpload({ filename: String(r.content[0].attachment.title || 'document'), mimeType: r.content[0].attachment.contentType, buffer: Buffer.from(data, 'base64'), title: 'Imported document', category: 'referral-letter' }, patient.id, 'import', client.facilityId);
        } catch (err: any) {
          issues.push({ severity: 'error', code: 'value', diagnostics: `Attachment rejected: ${String(err?.message || err).slice(0, 160)}`, expression: [`${at}.content[0].attachment`] });
        }
      }
      if (issues.length > before || !patient) continue;
      const author = this.authorRefs(r).map((ref) => practitionerRefs.get(ref) ?? this.deps.clinicians.find((c) => `Practitioner/${c.id}` === ref) ?? null)
        .find((c) => c && c.status === 'VERIFIED' && c.facilityId === client.facilityId);
      const category = r.resourceType === 'Observation' ? r.category?.[0]?.coding?.[0]?.code : undefined;
      planned.push({ resource: r, patientId: patient.id, externalKey, authorClinicianId: kind === 'LAB' ? undefined : author?.id, category, orderingClinicianId: orderer?.id });
    }
    if (issues.length) throw reject(422);

    // Pass 2: write (validation passed for every entry).
    const summary = { created: 0, updated: 0, unchanged: 0, drafts: 0 };
    const responseEntries: ImportResult['response']['entry'] = [];
    const newResults = new Map<string, string[]>(); // patientId -> ordering clinician ids (lab results)
    for (const p of planned) {
      const resource = this.normalise(structuredClone(p.resource)) as AnyClinicalFHIRResource;
      const subjectField = resource.resourceType === 'AllergyIntolerance' ? 'patient' : 'subject';
      (resource as any)[subjectField] = { reference: `Patient/${p.patientId}` };
      if (p.orderingClinicianId) (resource as any).basedOn = [{ display: `Ordered by ${this.deps.clinicians.find((c) => c.id === p.orderingClinicianId)?.fullName}` }];
      const { record, outcome } = this.deps.clinicalStore.importRecord(p.patientId, resource, {
        facilityId: client.facilityId, externalKey: p.externalKey, authorClinicianId: p.authorClinicianId, clientId: client.clientId, category: p.category,
        ...(p.orderingClinicianId ? { labResult: { orderingClinicianId: p.orderingClinicianId } } : {}),
      });
      if (p.orderingClinicianId && outcome !== 'unchanged') newResults.set(p.patientId, [...(newResults.get(p.patientId) || []), p.orderingClinicianId]);
      summary[outcome]++;
      if (record.status === 'draft' && outcome !== 'unchanged') summary.drafts++;
      responseEntries.push({
        response: {
          status: outcome === 'created' ? '201 Created' : '200 OK',
          location: `${record.resourceType}/${record.id}/_history/${record.versionId}`,
          ...(record.status === 'draft' ? { outcome: { resourceType: 'OperationOutcome', issue: [{ severity: 'warning', code: 'processing', diagnostics: 'Saved as a draft: a doctor must sign it before it is part of the record' }] } } : {}),
        },
      });
    }
    for (const l of pendingLinks) this.deps.links.add(client.facilityId, l.system, l.value, l.patientId);
    await this.notifyResults(newResults, client, info);
    this.deps.auditManager.appendEntry({
      actorId: `api-client:${client.clientId}`, action: 'FHIR_BUNDLE_IMPORTED', accessType: 'SYSTEM_ADMIN', facilityId: client.facilityId,
      ipAddress: info.ipAddress, userAgent: info.userAgent,
      reason: `Bundle imported: ${summary.created} created, ${summary.updated} updated, ${summary.unchanged} unchanged, ${summary.drafts} draft(s) awaiting a doctor`,
    });
    return { response: { resourceType: 'Bundle', type: 'transaction-response', entry: responseEntries }, summary };
  }
}
