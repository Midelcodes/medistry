/**
 * Pharmacies (Phase 17). A pharmacist (staff account of a PHARMACY facility) can, with the patient's consent:
 *   - read the patient's ACTIVE medications (latest doctor-signed MedicationStatements), nothing else;
 *   - record dispensing as a new MedicationDispense record. Prescriptions are never edited: no route changes a
 *     MedicationStatement, and the policy engine denies PHARMACIST every write except MEDICATION_DISPENSE.
 *
 * Consent is a time-limited grant to this pharmacist and pharmacy with scopes MedicationStatement and
 * MedicationDispense (shown to and revocable by the patient like any other consent). It is obtained by:
 *   - OTP: the pharmacist asks; a one-time code goes to the patient's own phone and app; the patient reads it out;
 *   - card: the patient's offline card QR is scanned while online and checked against the current card (signature,
 *     not revoked, not superseded). Showing the card at the counter is the consent.
 */
import type { PatientEntity } from '../patient/profile.ts';
import type { ClinicalDataStore } from '../clinical/store.ts';
import type { ConsentLifecycleManager } from '../consent/consentManager.ts';
import type { ConsentContext } from '../policy/enforcer.ts';
import type { OfflineCardStore } from '../emergency/offlineCardStore.ts';
import type { NotificationDispatcher } from '../notifications/dispatcher.ts';
import type { AccountStore, UserAccount } from '../auth/accounts.ts';
import type { AuditChainManager } from '../audit/hashChain.ts';
import type { SeedFacility } from '../../../prisma/seed.ts';
import { AuthError, type RequestInfo } from '../auth/patientAuth.ts';
import { evaluatePolicy } from '../policy/enforcer.ts';
import { verifyCompactJws, getPublicJwks } from '../crypto/cardKeys.ts';

export const PHARMACY_SCOPES = ['MedicationStatement', 'MedicationDispense'];
// How long a pharmacy's consent lasts. An operational choice; the patient can revoke it at any time.
export const PHARMACY_ACCESS_HOURS = Math.min(72, Math.max(1, parseInt(process.env.PHARMACY_ACCESS_HOURS || '12', 10) || 12));

export class PharmacyService {
  private deps: {
    clinicalStore: ClinicalDataStore; consentManager: ConsentLifecycleManager; offlineCards: OfflineCardStore; dispatcher: NotificationDispatcher;
    accounts: AccountStore; auditManager: AuditChainManager; facilities: SeedFacility[]; patientsById: Map<string, PatientEntity>;
    patientByCode: (code: string) => PatientEntity | undefined;
  };

  constructor(deps: PharmacyService['deps']) {
    this.deps = deps;
  }

  private pharmacy(p: UserAccount): SeedFacility {
    const f = this.deps.facilities.find((x) => x.id === p.facilityId);
    if (p.role !== 'PHARMACIST' || !f || f.kind !== 'PHARMACY') throw new AuthError(403, 'Pharmacist sign-in required');
    return f;
  }

  private request(p: UserAccount, f: SeedFacility, patient: PatientEntity) {
    return this.deps.consentManager.createAccessRequest({
      patientId: patient.id, clinicianId: p.id, clinicianName: `${p.displayName || 'Pharmacist'} (pharmacist)`, facilityId: f.id, facilityName: f.name,
      requestedScopes: PHARMACY_SCOPES, durationPreset: 'CUSTOM', customHours: PHARMACY_ACCESS_HOURS,
      clinicalReason: 'Pharmacy: view current medicines and record dispensing',
    });
  }

  /** OTP route: a code goes to the patient's own phone (SMS template) and app; the pharmacist never sees it. */
  async requestOtp(p: UserAccount, emergencyCode: unknown, info: RequestInfo): Promise<{ requestId: string; expiresAt: number; sentTo: string[] }> {
    const f = this.pharmacy(p);
    const patient = this.deps.patientByCode(String(emergencyCode || ''));
    if (!patient) throw new AuthError(404, 'No patient with that emergency code');
    const { requestId, rawOtp, expiresAt } = this.request(p, f, patient);
    const account = this.deps.accounts.byPatient(patient.id);
    const phone = account ? this.deps.accounts.phoneOf(account) : undefined;
    const sentTo: string[] = ['app'];
    if (phone) {
      await this.deps.dispatcher.sendSms(phone, { template: 'pharmacy_access_code', locale: patient.preferredLocale, vars: { code: rawOtp } });
      sentTo.push('sms');
    }
    await this.deps.dispatcher.notifyUser(patient.id, 'Pharmacy access request', `${f.name} asks to see your current medicines. Code: ${rawOtp}. Share it only with the pharmacist serving you.`);
    this.audit('PHARMACY_ACCESS_REQUESTED', p, patient.id, info, `Pharmacy ${f.id} requested medication access (one-time code sent to the patient)`);
    return { requestId, expiresAt, sentTo };
  }

  confirmOtp(p: UserAccount, requestId: string, otp: unknown, info: RequestInfo): { patientId: string; validUntil: string } {
    this.pharmacy(p);
    let grant;
    try {
      grant = this.deps.consentManager.approveViaOtp(requestId, String(otp || '').trim(), p.id);
    } catch (err: any) {
      throw new AuthError(403, err.message);
    }
    this.audit('PHARMACY_ACCESS_GRANTED', p, grant.patientId, info, `Medication access granted by one-time code for ${PHARMACY_ACCESS_HOURS}h`);
    return { patientId: grant.patientId, validUntil: new Date(grant.validUntil).toISOString() };
  }

  /** Card route (online): the scanned QR must be the patient's current, unrevoked, validly signed card. */
  cardAccess(p: UserAccount, token: unknown, info: RequestInfo): { patientId: string; validUntil: string } {
    const f = this.pharmacy(p);
    const check = verifyCompactJws(String(token || '').replace(/^.*#/, ''), getPublicJwks());
    const payload = check.payload;
    if (!check.valid || !payload || payload.typ === 'clinician-pass' || typeof payload.sub !== 'string') throw new AuthError(403, `Not a valid Medistry card${check.error ? ` (${check.error})` : ''}`);
    const patient = this.deps.patientsById.get(payload.sub);
    const current = patient ? this.deps.offlineCards.getCurrent(patient.id) : undefined;
    if (!patient || !current || current.version !== payload.cv) throw new AuthError(403, 'This card was revoked or replaced. Ask the patient for their current card or use a one-time code.');
    const { requestId } = this.request(p, f, patient);
    const grant = this.deps.consentManager.approveInApp(requestId, patient.id);
    this.audit('PHARMACY_ACCESS_BY_CARD', p, patient.id, info, `Medication access granted by scanning the patient's current card (version ${current.version}) for ${PHARMACY_ACCESS_HOURS}h`);
    return { patientId: patient.id, validUntil: new Date(grant.validUntil).toISOString() };
  }

  private consent(p: UserAccount, f: SeedFacility, patientId: string): ConsentContext | null {
    return this.deps.consentManager.resolveActiveConsent(patientId, p.id, f.id);
  }

  private authorise(p: UserAccount, f: SeedFacility, patientId: string, action: 'MEDICATION_READ' | 'MEDICATION_DISPENSE'): void {
    const decision = evaluatePolicy({ actor: { userId: p.id, role: 'PHARMACIST', clinicianId: p.id, facilityId: f.id }, action, targetPatientId: patientId, activeConsent: this.consent(p, f, patientId) });
    if (!decision.allowed) throw new AuthError(403, decision.reason);
  }

  private activeStatements(patientId: string) {
    return this.deps.clinicalStore.getLatestFinalRecords(patientId, 'MedicationStatement').filter(({ resource }) => (resource as any).status === 'active');
  }

  /** Active medications only: name, dosage, since when. No diagnoses, allergies or other records. */
  medications(p: UserAccount, patientId: string, info: RequestInfo) {
    const f = this.pharmacy(p);
    if (!this.deps.patientsById.has(patientId)) throw new AuthError(404, 'Patient not found');
    this.authorise(p, f, patientId, 'MEDICATION_READ');
    const meds = this.activeStatements(patientId).map(({ record, resource }) => ({
      medicationStatementId: record.id, name: (resource as any).medicationCodeableConcept?.text, dosage: (resource as any).dosage?.[0]?.text || null,
      since: (resource as any).effectiveDateTime || record.effectiveDate,
    }));
    this.audit('PHARMACY_MEDICATIONS_VIEWED', p, patientId, info, `Pharmacy viewed ${meds.length} active medication(s)`);
    return { medications: meds };
  }

  /** Records a MedicationDispense. The prescription (MedicationStatement) is referenced, never changed. */
  dispense(p: UserAccount, patientId: string, body: any, info: RequestInfo) {
    const f = this.pharmacy(p);
    this.authorise(p, f, patientId, 'MEDICATION_DISPENSE');
    const statement = this.activeStatements(patientId).find(({ record }) => record.id === body?.medicationStatementId);
    if (!statement) throw new AuthError(404, 'No active medication with that id for this patient');
    const quantity = Number(body.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 10_000) throw new AuthError(400, 'quantity must be a positive number');
    const unit = String(body.unit || 'unit').replace(/[^\w /.-]/g, '').slice(0, 30);
    const now = new Date().toISOString();
    const resource: any = {
      resourceType: 'MedicationDispense', id: '', status: 'completed',
      medicationCodeableConcept: { text: (statement.resource as any).medicationCodeableConcept?.text },
      subject: { reference: `Patient/${patientId}` },
      performer: [{ actor: { display: f.name } }],
      quantity: { value: quantity, unit },
      whenHandedOver: now,
      // MedicationDispense.authorizingPrescription expects a MedicationRequest; Medistry holds MedicationStatements.
      supportingInformation: [{ reference: `MedicationStatement/${statement.record.id}` }],
      ...(body.note ? { note: [{ text: String(body.note).replace(/[\u0000-\u001f]/g, ' ').slice(0, 300) }] } : {}),
    };
    const record = this.deps.clinicalStore.writeServiceRecord(patientId, resource, {
      source: 'pharmacy', facilityId: f.id, authorId: p.id, action: 'MEDICATION_DISPENSED', reason: `Dispensing recorded by pharmacy ${f.id} against medication ${statement.record.id} (prescription unchanged)`,
    });
    return { dispenseId: record.id, medicationStatementId: statement.record.id, statementVersion: statement.record.versionId };
  }

  private audit(action: string, p: UserAccount, patientId: string, info: RequestInfo, reason: string): void {
    this.deps.auditManager.appendEntry({ actorId: p.id, subjectId: patientId, action, accessType: 'NORMAL_CONSENT', facilityId: p.facilityId, ipAddress: info.ipAddress, userAgent: info.userAgent, reason });
  }
}
