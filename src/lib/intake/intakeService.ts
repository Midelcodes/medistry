/**
 * AI intake for paper-based facilities (Phase 15): photo, voice note or typed text -> proposed FHIR drafts that a
 * doctor reviews, edits and signs. The agent never signs anything.
 *
 *   1. A photo or voice note is checked and stored encrypted (SecureDocumentManager: size, content type, malware).
 *   2. Text is extracted (OcrAdapter / SpeechToTextAdapter), or taken as typed.
 *   3. The LlmAdapter proposes fields; every field carries the source span it came from. Spans are checked against
 *      the source text (a span that is not in the text gets confidence 0); fields below LOW_CONFIDENCE are flagged.
 *      Only known fields per resource type are accepted, so a model cannot write anything else into a record.
 *   4. Each proposal is stored as a DRAFT record (source 'ai-draft'), invisible to the record view, the emergency
 *      summary and the card until signed.
 *   5. The doctor edits (each edit is a new draft version), discards, or signs (one call signs all remaining
 *      drafts). Audit: AI_DRAFT_CREATED and AI_DRAFT_SIGNED, with the adapter and model names.
 */
import crypto from 'node:crypto';
import { encryptField, decryptField, type PatientEntity } from '../patient/profile.ts';
import type { ActorContext, ConsentContext } from '../policy/enforcer.ts';
import type { AnyClinicalFHIRResource, ClinicalDataStore } from '../clinical/store.ts';
import type { AuditChainManager } from '../audit/hashChain.ts';
import type { SecureDocumentManager } from '../clinical/fileUpload.ts';
import { LOW_CONFIDENCE, type IntakeResourceType, type LlmAdapter, type OcrAdapter, type ProposedResource, type SourceSpan, type SpeechToTextAdapter } from './adapters.ts';

export const MAX_INTAKE_TEXT = 20_000;

/** The only fields a proposal (or a doctor's edit) may set, per resource type. */
export const INTAKE_FIELDS: Record<IntakeResourceType, string[]> = {
  Condition: ['code.text', 'note[0].text'],
  AllergyIntolerance: ['code.text', 'reaction[0].manifestation[0].text', 'reaction[0].severity'],
  MedicationStatement: ['medicationCodeableConcept.text', 'dosage[0].text'],
  Observation: ['code.text', 'value'],
  Encounter: ['reasonCode[0].text'],
};
const REQUIRED: Record<IntakeResourceType, string> = {
  Condition: 'code.text', AllergyIntolerance: 'code.text', MedicationStatement: 'medicationCodeableConcept.text', Observation: 'code.text', Encounter: 'reasonCode[0].text',
};

export interface ReviewField { path: string; value: string; span: SourceSpan | null; confidence: number; lowConfidence: boolean; edited?: boolean }
interface Proposal { key: string; resourceType: IntakeResourceType; recordId: string; state: 'draft' | 'signed' | 'discarded'; fields: ReviewField[] }

export interface IntakeSession {
  id: string;
  patientId: string;
  clinicianId: string;
  facilityId: string;
  kind: 'photo' | 'voice' | 'text';
  adapters: { ocr?: string; stt?: string; llm: string; model: string };
  encryptedSourceText: string;
  encryptedFile?: string;
  fileMimeType?: string;
  fileSha256?: string;
  encryptedProposals: string; // AES-256-GCM JSON of Proposal[] (values and spans are health data)
  status: 'review' | 'signed';
  createdAt: string;
  updatedAt: string;
}

export interface IntakeSessionRepo { saveIntakeSession(s: IntakeSession): void }

export class IntakeError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** FHIR resource for a proposal. Missing required value: null (the proposal is dropped). */
function buildResource(type: IntakeResourceType, v: Record<string, string>, patientId: string, now: string): AnyClinicalFHIRResource | null {
  if (!v[REQUIRED[type]]) return null;
  const subject = { reference: `Patient/${patientId}` };
  switch (type) {
    case 'Condition':
      return {
        resourceType: 'Condition', id: '', code: { text: v['code.text'] }, subject, recordedDate: now,
        clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active', display: 'Active' }], text: 'Active' },
        ...(v['note[0].text'] ? { note: [{ text: v['note[0].text'] }] } : {}),
      } as any;
    case 'AllergyIntolerance': {
      const severity = ['mild', 'moderate', 'severe'].includes(v['reaction[0].severity']) ? v['reaction[0].severity'] : undefined;
      const manifestation = v['reaction[0].manifestation[0].text'];
      return {
        resourceType: 'AllergyIntolerance', id: '', code: { text: v['code.text'] }, patient: subject, recordedDate: now, criticality: 'unable-to-assess',
        clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] },
        ...(severity || manifestation ? { reaction: [{ manifestation: [{ text: manifestation || 'Not recorded' }], ...(severity ? { severity } : {}) }] } : {}),
      } as any;
    }
    case 'MedicationStatement':
      return {
        resourceType: 'MedicationStatement', id: '', status: 'active', medicationCodeableConcept: { text: v['medicationCodeableConcept.text'] }, subject,
        dateAsserted: now, effectiveDateTime: now, ...(v['dosage[0].text'] ? { dosage: [{ text: v['dosage[0].text'] }] } : {}),
      } as any;
    case 'Observation':
      return { resourceType: 'Observation', id: '', status: 'final', code: { text: v['code.text'] }, subject, effectiveDateTime: now, valueString: v.value || 'Not recorded' } as any;
    case 'Encounter':
      return {
        resourceType: 'Encounter', id: '', status: 'finished', subject, period: { start: now },
        // TODO: the encounter class is not in the source text; ambulatory is assumed and shown to the doctor for review.
        class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
        reasonCode: [{ text: v['reasonCode[0].text'] }],
      } as any;
  }
}

export class IntakeService {
  private sessions = new Map<string, IntakeSession>();
  private deps: {
    clinicalStore: ClinicalDataStore; auditManager: AuditChainManager; documents: SecureDocumentManager;
    ocr: OcrAdapter; stt: SpeechToTextAdapter; llm: () => LlmAdapter;
  };
  persistence?: IntakeSessionRepo;

  constructor(deps: IntakeService['deps']) {
    this.deps = deps;
  }

  hydrate(rows: IntakeSession[]): void {
    for (const s of rows) this.sessions.set(s.id, s);
  }

  private proposals(s: IntakeSession): Proposal[] {
    return JSON.parse(decryptField(s.encryptedProposals));
  }

  private save(s: IntakeSession, proposals: Proposal[]): void {
    s.encryptedProposals = encryptField(JSON.stringify(proposals));
    s.updatedAt = new Date().toISOString();
    this.persistence?.saveIntakeSession(s);
  }

  private session(id: string, actor: ActorContext): IntakeSession {
    const s = this.sessions.get(id);
    // Same facility only: drafts are filed under it, and only its doctors can sign them.
    if (!s || s.facilityId !== actor.facilityId) throw new IntakeError(404, 'Intake not found');
    return s;
  }

  /** Checks a model's proposal: known paths only, values as short strings, spans verified against the source. */
  private reviewFields(p: ProposedResource, source: string): ReviewField[] {
    const allowed = INTAKE_FIELDS[p.resourceType] || [];
    const out: ReviewField[] = [];
    for (const f of Array.isArray(p.fields) ? p.fields : []) {
      if (!allowed.includes(f?.path) || f.value === undefined || f.value === null) continue;
      const value = String(f.value).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 500);
      if (!value) continue;
      let span: SourceSpan | null = null;
      const s = f.span;
      if (s && typeof s.text === 'string' && s.text) {
        if (source.slice(s.start, s.end) === s.text) span = { start: s.start, end: s.end, text: s.text };
        else {
          const at = source.indexOf(s.text);
          if (at >= 0) span = { start: at, end: at + s.text.length, text: s.text };
        }
      }
      const confidence = span ? Math.max(0, Math.min(1, Number(f.confidence) || 0)) : 0;
      out.push({ path: f.path, value, span, confidence, lowConfidence: confidence < LOW_CONFIDENCE });
    }
    return out;
  }

  async create(
    input: { patient: PatientEntity; kind: unknown; text?: unknown; file?: { filename?: unknown; mimeType?: unknown; contentBase64?: unknown } },
    actor: ActorContext,
    consent: ConsentContext,
    info: { ipAddress: string; userAgent: string },
  ) {
    const kind = input.kind;
    if (kind !== 'photo' && kind !== 'voice' && kind !== 'text') throw new IntakeError(400, 'kind must be photo, voice or text');
    let sourceText: string;
    let upload: Awaited<ReturnType<SecureDocumentManager['processIntakeUpload']>> | undefined;
    const adapters: IntakeSession['adapters'] = { llm: '', model: '' };
    if (kind === 'text') {
      if (typeof input.text !== 'string' || !input.text.trim()) throw new IntakeError(400, 'Give the text of the note');
      sourceText = input.text;
    } else {
      const f = input.file || {};
      if (typeof f.contentBase64 !== 'string' || !f.contentBase64) throw new IntakeError(400, kind === 'photo' ? 'Attach the photo' : 'Attach the voice note');
      try {
        upload = await this.deps.documents.processIntakeUpload({ filename: String(f.filename || kind), mimeType: String(f.mimeType || ''), buffer: Buffer.from(f.contentBase64, 'base64'), kind });
      } catch (err: any) {
        throw new IntakeError(400, err.message);
      }
      if (kind === 'photo') {
        adapters.ocr = this.deps.ocr.name;
        sourceText = (await this.deps.ocr.extractText(upload.stored, upload.mimeType)).text;
      } else {
        adapters.stt = this.deps.stt.name;
        sourceText = (await this.deps.stt.transcribe(upload.stored, upload.mimeType)).text;
      }
    }
    if (sourceText.length > MAX_INTAKE_TEXT) throw new IntakeError(400, `The note is longer than ${MAX_INTAKE_TEXT} characters`);

    const llm = this.deps.llm();
    const structured = await llm.structure(sourceText);
    adapters.llm = llm.name;
    adapters.model = String(structured.model || llm.name).slice(0, 80);

    const now = new Date().toISOString();
    const proposals: Proposal[] = [];
    for (const p of Array.isArray(structured.resources) ? structured.resources : []) {
      if (!INTAKE_FIELDS[p?.resourceType as IntakeResourceType]) continue;
      const fields = this.reviewFields(p, sourceText);
      const resource = buildResource(p.resourceType, Object.fromEntries(fields.map((f) => [f.path, f.value])), input.patient.id, now);
      if (!resource) continue;
      const { record } = this.deps.clinicalStore.writeRecord(input.patient.id, resource, actor, {
        consent, facilityId: actor.facilityId!, source: 'ai-draft', forceDraft: true,
      });
      proposals.push({ key: crypto.randomUUID(), resourceType: p.resourceType, recordId: record.id, state: 'draft', fields });
    }

    const session: IntakeSession = {
      id: crypto.randomUUID(), patientId: input.patient.id, clinicianId: actor.clinicianId!, facilityId: actor.facilityId!, kind, adapters,
      encryptedSourceText: encryptField(sourceText), encryptedProposals: '', status: 'review', createdAt: now, updatedAt: now,
      ...(upload ? { encryptedFile: upload.encryptedPayload, fileMimeType: upload.mimeType, fileSha256: upload.sha256 } : {}),
    };
    this.sessions.set(session.id, session);
    this.save(session, proposals);
    const via = [adapters.ocr && `OCR ${adapters.ocr}`, adapters.stt && `speech-to-text ${adapters.stt}`, `structuring ${adapters.llm} (model ${adapters.model})`].filter(Boolean).join(', ');
    this.deps.auditManager.appendEntry({
      actorId: actor.userId, subjectId: input.patient.id, action: 'AI_DRAFT_CREATED', accessType: 'NORMAL_CONSENT', facilityId: actor.facilityId,
      resourceType: 'IntakeSession', resourceId: session.id, ipAddress: info.ipAddress, userAgent: info.userAgent,
      reason: `AI intake (${kind}) proposed ${proposals.length} draft(s) via ${via}; ${proposals.reduce((n, p) => n + p.fields.filter((f) => f.lowConfidence).length, 0)} low-confidence field(s); nothing signed`,
    });
    return this.review(session);
  }

  /** What the review screen shows: the source text, and each proposal with its fields, spans and current content. */
  review(s: IntakeSession) {
    const proposals = this.proposals(s).map((p) => {
      const record = this.deps.clinicalStore.getRecordById(p.recordId);
      return {
        key: p.key, recordId: p.recordId, state: p.state, resourceType: p.resourceType, fields: p.fields,
        versionId: record?.versionId, resource: record ? JSON.parse(decryptField(record.encryptedPayload)) : null,
      };
    });
    return {
      intakeId: s.id, patientId: s.patientId, kind: s.kind, status: s.status, adapters: s.adapters, createdAt: s.createdAt,
      sourceText: decryptField(s.encryptedSourceText), hasFile: !!s.encryptedFile,
      lowConfidenceFields: proposals.reduce((n, p) => n + p.fields.filter((f) => f.lowConfidence).length, 0),
      proposals,
    };
  }

  /** Session metadata for the retention report (no content, no files). */
  retentionView(): Array<{ id: string; status: string; updatedAt: string; hasFile: boolean }> {
    return [...this.sessions.values()].map((s) => ({ id: s.id, status: s.status, updatedAt: s.updatedAt, hasFile: !!s.fileSha256 }));
  }

  get(id: string, actor: ActorContext) {
    return this.review(this.session(id, actor));
  }

  /** The doctor edits a draft's fields. Becomes a new draft version; the earlier version is kept. */
  revise(id: string, recordId: string, edits: unknown, actor: ActorContext, consent: ConsentContext) {
    const s = this.session(id, actor);
    const proposals = this.proposals(s);
    const p = proposals.find((x) => x.recordId === recordId);
    if (!p || p.state !== 'draft') throw new IntakeError(404, 'Draft not found (it may already be signed or discarded)');
    if (!edits || typeof edits !== 'object') throw new IntakeError(400, 'Give the edited fields as {"path": "value"}');
    const allowed = INTAKE_FIELDS[p.resourceType];
    const values = Object.fromEntries(p.fields.map((f) => [f.path, f.value]));
    for (const [path, value] of Object.entries(edits as Record<string, unknown>)) {
      if (!allowed.includes(path)) throw new IntakeError(400, `${path} cannot be set on ${p.resourceType}. Allowed: ${allowed.join(', ')}`);
      const v = String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 500);
      values[path] = v;
      const field = p.fields.find((f) => f.path === path);
      if (field) Object.assign(field, { value: v, edited: true, lowConfidence: false });
      else p.fields.push({ path, value: v, span: null, confidence: 1, lowConfidence: false, edited: true });
    }
    const resource = buildResource(p.resourceType, values, s.patientId, new Date().toISOString());
    if (!resource) throw new IntakeError(400, `${REQUIRED[p.resourceType]} cannot be empty`);
    const { record } = this.deps.clinicalStore.reviseDraft(recordId, resource, actor, { consent, facilityId: s.facilityId });
    p.recordId = record.id;
    this.save(s, proposals);
    return this.review(s);
  }

  discard(id: string, recordId: string, reason: unknown, actor: ActorContext, consent: ConsentContext) {
    const s = this.session(id, actor);
    const proposals = this.proposals(s);
    const p = proposals.find((x) => x.recordId === recordId);
    if (!p || p.state !== 'draft') throw new IntakeError(404, 'Draft not found (it may already be signed or discarded)');
    this.deps.clinicalStore.discardDraft(recordId, actor, { consent, facilityId: s.facilityId, reason: String(reason || 'Not correct') });
    p.state = 'discarded';
    this.save(s, proposals);
    return this.review(s);
  }

  /** Signs the remaining drafts (all, or the listed record ids): each becomes a new, final version. */
  signAll(id: string, actor: ActorContext, consent: ConsentContext, info: { ipAddress: string; userAgent: string }, recordIds?: unknown) {
    const s = this.session(id, actor);
    const proposals = this.proposals(s);
    const only = Array.isArray(recordIds) ? new Set(recordIds.map(String)) : null;
    const toSign = proposals.filter((p) => p.state === 'draft' && (!only || only.has(p.recordId)));
    if (!toSign.length) throw new IntakeError(409, 'There are no drafts left to sign');
    for (const p of toSign) {
      const { record } = this.deps.clinicalStore.signDraft(p.recordId, actor, { consent, facilityId: s.facilityId });
      p.recordId = record.id;
      p.state = 'signed';
    }
    if (!proposals.some((p) => p.state === 'draft')) s.status = 'signed';
    this.save(s, proposals);
    const edited = toSign.filter((p) => p.fields.some((f) => f.edited)).length;
    this.deps.auditManager.appendEntry({
      actorId: actor.userId, subjectId: s.patientId, action: 'AI_DRAFT_SIGNED', accessType: 'NORMAL_CONSENT', facilityId: s.facilityId,
      resourceType: 'IntakeSession', resourceId: s.id, ipAddress: info.ipAddress, userAgent: info.userAgent,
      reason: `${toSign.length} AI draft(s) signed by the doctor (${edited} edited first); proposed by ${s.adapters.llm} (model ${s.adapters.model})${s.adapters.ocr ? `, OCR ${s.adapters.ocr}` : ''}${s.adapters.stt ? `, speech-to-text ${s.adapters.stt}` : ''}`,
    });
    return this.review(s);
  }
}
