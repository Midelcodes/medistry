/**
 * National exchange sync (Phase 17).
 *
 * Outbound (outbox pattern): when a record becomes final (doctor-signed, or a lab-reported result) and the patient
 * has an active 'national-exchange' consent, an OutboxMessage is queued. A worker loop sends due messages through the
 * country's connector. Transient failures are retried with exponential backoff; after OUTBOX_MAX_ATTEMPTS, or on a
 * permanent failure, the message is dead-lettered for an admin to inspect and retry. Consent is checked again at send
 * time (withdrawn consent cancels the message). The outbox stores ids only, never a copy of the record. Every push,
 * failure, dead letter and cancellation is audited.
 *
 * Inbound: queryPatientSummary is called only by a clinician with the patient's consent or an active break-glass
 * grant. Results are returned labelled "National exchange (KE/NG)" and are never written into Medistry's record.
 */
import crypto from 'node:crypto';
import { decryptField, type PatientEntity } from '../../patient/profile.ts';
import type { AuditChainManager } from '../../audit/hashChain.ts';
import type { ClinicalDataStore, FinalRecordEvent } from '../../clinical/store.ts';
import type { ConsentLifecycleManager } from '../../consent/consentManager.ts';
import type { IdentityStore } from '../../identity/identityStore.ts';
import type { UserAccount } from '../../auth/accounts.ts';
import type { HieConnector } from './HieConnector.ts';

export const NATIONAL_EXCHANGE_SCOPE = 'national-exchange';
export const OUTBOX_MAX_ATTEMPTS = Math.max(1, parseInt(process.env.OUTBOX_MAX_ATTEMPTS || '5', 10) || 5);
export const OUTBOX_RETRY_BASE_MS = Math.max(1, parseInt(process.env.OUTBOX_RETRY_BASE_SECONDS || '60', 10) || 60) * 1000;

export interface OutboxMessage {
  id: string;
  kind: 'hie-push';
  connector: string;   // country code of the connector
  patientId: string;
  recordId: string;
  resourceType: string;
  facilityId: string;  // the record's origin facility (for the facility admin view)
  status: 'PENDING' | 'SENT' | 'DEAD' | 'CANCELLED';
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;  // never a response body or patient data
  remoteId?: string;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
}

export interface OutboxRepo { saveOutboxMessage(m: OutboxMessage): void }

const SYSTEM = { ipAddress: '127.0.0.1', userAgent: 'Medistry/outbox' };
// References to Medistry-internal ids mean nothing to an exchange: keep only their display text.
const LOCAL_REFS = ['participant', 'recorder', 'asserter', 'performer', 'informationSource', 'resultsInterpreter', 'author', 'encounter', 'basedOn', 'supportingInformation'];

export class NationalExchangeService {
  private messages = new Map<string, OutboxMessage>();
  private deps: {
    connectors: Map<string, HieConnector>; clinicalStore: ClinicalDataStore; consentManager: ConsentLifecycleManager;
    identity: IdentityStore; patientsById: Map<string, PatientEntity>; auditManager: AuditChainManager;
  };
  persistence?: OutboxRepo;
  private running = false;

  constructor(deps: NationalExchangeService['deps']) {
    this.deps = deps;
  }

  hydrate(rows: OutboxMessage[]): void {
    for (const m of rows) this.messages.set(m.id, m);
  }

  private save(m: OutboxMessage, patch: Partial<OutboxMessage>): void {
    Object.assign(m, patch, { updatedAt: new Date().toISOString() });
    this.persistence?.saveOutboxMessage(m);
  }

  private audit(action: string, m: OutboxMessage, reason: string, actorId = 'system'): void {
    this.deps.auditManager.appendEntry({
      actorId, subjectId: m.patientId, action, accessType: 'SYSTEM_ADMIN', facilityId: m.facilityId, resourceType: m.resourceType, resourceId: m.recordId,
      ipAddress: SYSTEM.ipAddress, userAgent: SYSTEM.userAgent, reason,
    });
  }

  hasConsent(patientId: string): boolean {
    const now = Date.now();
    return this.deps.consentManager.getPatientConsents(patientId)
      .some((g) => !g.isRevoked && new Date(g.validUntil).getTime() > now && g.scopes.includes(NATIONAL_EXCHANGE_SCOPE));
  }

  connectorFor(patient: PatientEntity): HieConnector | undefined {
    const c = this.deps.connectors.get(patient.countryCode);
    return c && c.getStatus().configured ? c : undefined;
  }

  /** Queues a final record for the national exchange, if the patient consents and the country has a connector. */
  onFinalRecord(event: FinalRecordEvent): OutboxMessage | null {
    const { record } = event;
    if (record.source === 'patient-reported' || record.status !== 'final') return null;
    const patient = this.deps.patientsById.get(record.patientId);
    if (!patient || !this.hasConsent(patient.id)) return null;
    const connector = this.connectorFor(patient);
    if (!connector) return null;
    const now = new Date().toISOString();
    const m: OutboxMessage = {
      id: crypto.randomUUID(), kind: 'hie-push', connector: connector.country, patientId: patient.id, recordId: record.id,
      resourceType: record.resourceType, facilityId: record.originFacilityId, status: 'PENDING', attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now,
    };
    this.messages.set(m.id, m);
    this.persistence?.saveOutboxMessage(m);
    this.audit('NATIONAL_EXCHANGE_QUEUED', m, `Record queued for ${connector.name} (patient consent: national-exchange)`);
    return m;
  }

  /** The national identifier the exchange accepts for this patient, decrypted in memory only. */
  private identityFor(patientId: string, connector: HieConnector): { system: string; value: string; idType: string } | null {
    for (const i of this.deps.identity.forPatient(patientId)) {
      if (i.country !== connector.country) continue;
      const system = connector.patientIdentifierSystem(i.idType);
      if (system) return { system, value: decryptField(i.encryptedValue), idType: i.idType };
    }
    return null;
  }

  /** The record as sent: subject by national identifier, internal references reduced to display text. */
  private exchangeResource(resource: any, recordId: string, subject: { system: string; value: string }): Record<string, any> {
    const out = structuredClone(resource);
    delete out.id;
    const field = out.resourceType === 'AllergyIntolerance' ? 'patient' : 'subject';
    out[field] = { identifier: subject };
    const strip = (ref: any): any => (Array.isArray(ref) ? ref.map(strip).filter(Boolean) : ref && typeof ref === 'object' ? (ref.reference ? (ref.display ? { display: ref.display } : undefined) : ref.individual ? { ...ref, individual: strip(ref.individual) } : ref) : ref);
    for (const k of LOCAL_REFS) if (out[k] !== undefined) out[k] = strip(out[k]);
    for (const k of LOCAL_REFS) if (out[k] === undefined || (Array.isArray(out[k]) && !out[k].length)) delete out[k];
    out.identifier = [...(Array.isArray(out.identifier) ? out.identifier : []), { system: 'urn:medistry:record-id', value: recordId }];
    return out;
  }

  private async send(m: OutboxMessage, now: number): Promise<void> {
    const patient = this.deps.patientsById.get(m.patientId);
    const connector = this.deps.connectors.get(m.connector);
    if (!patient || !this.hasConsent(m.patientId)) {
      this.save(m, { status: 'CANCELLED', lastError: 'patient consent for national exchange withdrawn' });
      this.audit('NATIONAL_EXCHANGE_CANCELLED', m, 'Not sent: the patient withdrew national-exchange consent');
      return;
    }
    const dead = (reason: string) => {
      this.save(m, { status: 'DEAD', lastError: reason });
      this.audit('NATIONAL_EXCHANGE_DEAD_LETTER', m, `Dead-lettered after ${m.attempts} attempt(s): ${reason}`);
    };
    if (!connector) return dead('no connector for this country');
    const subject = this.identityFor(m.patientId, connector);
    if (!subject) return dead('the patient has no national identifier the exchange accepts');
    const record = this.deps.clinicalStore.getRecordById(m.recordId);
    if (!record || record.status !== 'final') return dead('record not found or not final');
    const resource = this.exchangeResource(JSON.parse(decryptField(record.encryptedPayload)), record.id, { system: subject.system, value: subject.value });
    m.attempts += 1;
    try {
      const { remoteId } = await connector.pushRecord(resource);
      this.save(m, { status: 'SENT', sentAt: new Date(now).toISOString(), remoteId, lastError: undefined });
      this.audit('NATIONAL_EXCHANGE_PUSHED', m, `Pushed to ${connector.name} (attempt ${m.attempts})${remoteId ? `, remote id ${remoteId}` : ''}`);
    } catch (err: any) {
      const reason = String(err?.message || 'error').slice(0, 120);
      const retryable = err?.retryable !== false;
      if (retryable && m.attempts < OUTBOX_MAX_ATTEMPTS) {
        this.save(m, { lastError: reason, nextAttemptAt: new Date(now + OUTBOX_RETRY_BASE_MS * 2 ** (m.attempts - 1)).toISOString() });
        this.audit('NATIONAL_EXCHANGE_PUSH_FAILED', m, `Push to ${connector.name} failed (attempt ${m.attempts}/${OUTBOX_MAX_ATTEMPTS}): ${reason}; will retry`);
      } else {
        dead(reason);
      }
    }
  }

  /** Worker step: sends every due PENDING message once. Safe to call on a timer (does not overlap itself). */
  async processDue(now = Date.now()): Promise<{ attempted: number }> {
    if (this.running) return { attempted: 0 };
    this.running = true;
    let attempted = 0;
    try {
      for (const m of [...this.messages.values()]) {
        if (m.status !== 'PENDING' || Date.parse(m.nextAttemptAt) > now) continue;
        attempted++;
        await this.send(m, now);
      }
    } finally {
      this.running = false;
    }
    return { attempted };
  }

  private visibleTo(admin: UserAccount, m: OutboxMessage): boolean {
    return admin.role === 'PLATFORM_ADMIN' || (admin.role === 'FACILITY_ADMIN' && m.facilityId === admin.facilityId);
  }

  /** Admin requeues a dead-lettered message. */
  retry(admin: UserAccount, id: string): OutboxMessage {
    const m = this.messages.get(id);
    if (!m || !this.visibleTo(admin, m)) throw Object.assign(new Error('Outbox message not found'), { status: 404 });
    if (m.status !== 'DEAD') throw Object.assign(new Error('Only dead-lettered messages can be retried'), { status: 409 });
    this.save(m, { status: 'PENDING', attempts: 0, nextAttemptAt: new Date().toISOString(), lastError: undefined });
    this.audit('NATIONAL_EXCHANGE_REQUEUED', m, 'Dead-lettered message requeued by an admin', admin.id);
    return m;
  }

  /** Facility admin view: connector status, last sync, queued, failed. No patient data beyond record ids. */
  adminView(admin: UserAccount) {
    const mine = [...this.messages.values()].filter((m) => this.visibleTo(admin, m));
    const count = (s: OutboxMessage['status']) => mine.filter((m) => m.status === s).length;
    const lastSync = mine.map((m) => m.sentAt).filter((x): x is string => !!x).sort().at(-1) || null;
    return {
      connectors: [...this.deps.connectors.values()].map((c) => c.getStatus()),
      outbox: { queued: count('PENDING'), sent: count('SENT'), failed: count('DEAD'), cancelled: count('CANCELLED') },
      lastSyncAt: lastSync,
      deadLetters: mine.filter((m) => m.status === 'DEAD').map((m) => ({ id: m.id, recordId: m.recordId, resourceType: m.resourceType, connector: m.connector, attempts: m.attempts, lastError: m.lastError, updatedAt: m.updatedAt })),
      retrying: mine.filter((m) => m.status === 'PENDING' && m.attempts > 0).map((m) => ({ id: m.id, attempts: m.attempts, nextAttemptAt: m.nextAttemptAt, lastError: m.lastError })),
    };
  }

  /** Inbound summary for an authorised clinician (consent or break-glass checked by the caller). Not stored. */
  async querySummary(patient: PatientEntity, actor: { userId: string; facilityId?: string; basis: 'consent' | 'break-glass' }) {
    const connector = this.connectorFor(patient);
    if (!connector) throw Object.assign(new Error('No national exchange is configured for this patient\'s country'), { status: 503 });
    const id = this.identityFor(patient.id, connector);
    if (!id) throw Object.assign(new Error('The patient has no national identifier the exchange accepts'), { status: 409 });
    const { resources } = await connector.queryPatientSummary({ country: connector.country, idType: id.idType, idNumber: id.value, medistryPatientId: patient.id });
    this.deps.auditManager.appendEntry({
      actorId: actor.userId, subjectId: patient.id, action: 'NATIONAL_EXCHANGE_QUERIED', accessType: actor.basis === 'break-glass' ? 'EMERGENCY_BREAK_GLASS' : 'NORMAL_CONSENT',
      facilityId: actor.facilityId, ipAddress: SYSTEM.ipAddress, userAgent: 'ClinicalClient/1.0',
      reason: `Summary read from ${connector.name} (${resources.length} resource(s)) under ${actor.basis}; shown separately, not merged into the record`,
    });
    return { source: `National exchange (${connector.country})`, connector: connector.name, retrievedAt: new Date().toISOString(), mergedIntoRecord: false, resources };
  }

  all(): OutboxMessage[] {
    return [...this.messages.values()];
  }
}
