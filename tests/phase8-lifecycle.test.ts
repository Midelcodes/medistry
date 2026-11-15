import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { generateSeedData, type SeedClinician } from '../prisma/seed.ts';
import { AuditChainManager } from '../src/lib/audit/hashChain.ts';
import { ClinicalDataStore } from '../src/lib/clinical/store.ts';
import { ClinicalTimelineEngine } from '../src/lib/clinical/timeline.ts';
import { NotificationDispatcher, ConsoleNotificationProvider } from '../src/lib/notifications/dispatcher.ts';
import { EmergencyBreakGlassEngine } from '../src/lib/emergency/breakGlassEngine.ts';
import { OfflineCardStore } from '../src/lib/emergency/offlineCardStore.ts';
import { CardContentSync, RECORD_CHANGED_MESSAGE } from '../src/lib/emergency/cardSync.ts';
import { RecordFlagStore } from '../src/lib/clinical/recordFlags.ts';
import { buildCardPayload, validateCardSelection } from '../src/lib/emergency/cardPayload.ts';
import { buildOfflineCardBundle, PATIENT_REPORTED_LABEL } from '../src/lib/emergency/offlineCard.ts';
import { seedClinicalRecords } from '../src/lib/site/seedClinical.ts';
import { evaluatePolicy, type ActorContext, type ConsentContext } from '../src/lib/policy/enforcer.ts';
import { signScanEvent } from '../site/js/lib/offlineScan.js';
import type { PatientEntity } from '../src/lib/patient/profile.ts';

const DAY = 86_400_000;

/** Same wiring as src/server.ts: seed records first, then attach the card sync listener. */
function setup() {
  const seed = generateSeedData();
  const patientsById = new Map<string, PatientEntity>(seed.patients.map((p) => [p.patient.id, p.patient]));
  const auditManager = new AuditChainManager();
  const store = new ClinicalDataStore(auditManager);
  const timeline = new ClinicalTimelineEngine(store);
  const provider = new ConsoleNotificationProvider();
  const dispatcher = new NotificationDispatcher(provider);
  seedClinicalRecords(store, seed.patients.map((p) => p.patient), seed.clinicians, seed.facilities);
  const sync = new CardContentSync({ patientsById, dispatcher, auditManager });
  const syncResults: ReturnType<CardContentSync['handle']>[] = [];
  store.onFinalRecord((e) => syncResults.push(sync.handle(e)));
  const cards = new OfflineCardStore(auditManager);
  const flags = new RecordFlagStore({ clinicalStore: store, auditManager, dispatcher });
  const engine = new EmergencyBreakGlassEngine(auditManager, store, timeline, dispatcher);
  const amara = seed.patients[0].patient; // opted in: Sickle Cell Anemia (HbSS) + Hydroxyurea
  const doctor = seed.clinicians.find((c) => c.facilityId === amara.primaryFacilityId)!;
  return { seed, patientsById, auditManager, store, provider, cards, flags, engine, amara, doctor, syncResults };
}

const doctorActor = (c: SeedClinician, verified = true): ActorContext => ({ userId: c.userId, role: 'DOCTOR', clinicianId: c.id, facilityId: c.facilityId, isVerifiedClinician: verified });
const consentFor = (patientId: string, facilityId: string, clinicianId?: string): ConsentContext => ({
  id: `c-${crypto.randomUUID()}`, patientId, targetFacilityId: facilityId, targetClinicianId: clinicianId, scopes: ['all'], validUntil: new Date(Date.now() + DAY), isRevoked: false,
});
const patientActor = (p: PatientEntity): ActorContext => ({ userId: p.id, role: 'PATIENT' });

function findRecord(store: ClinicalDataStore, p: PatientEntity, type: string, text: string) {
  return store.getPatientRecords(p.id, patientActor(p), {}).find(({ record, resource }: any) =>
    record.resourceType === type && (resource.medicationCodeableConcept?.text === text || resource.code?.text === text))!;
}

const pushesTo = (provider: ConsoleNotificationProvider, id: string) => provider.sentPushLogs.filter((p) => p.toUserId === id);

describe('1. Signed changes keep the card in step', () => {
  test('A signed medication change marks the card stale and notifies the patient', () => {
    const { store, cards, provider, amara, doctor, auditManager } = setup();
    cards.issue(amara);
    assert.strictEqual(amara.cardStale, false);
    const hydroxyurea = amara.activeMedications.find((m) => m.medicationName === 'Hydroxyurea')!;
    const { record, resource } = findRecord(store, amara, 'MedicationStatement', 'Hydroxyurea');

    store.updateRecord(record.id, { ...(resource as any), dosage: [{ text: '1000mg daily (oral)' }] }, doctorActor(doctor), {
      consent: consentFor(amara.id, doctor.facilityId, doctor.id), facilityId: doctor.facilityId, reason: 'Dose increased',
    });

    assert.strictEqual(amara.cardStale, true);
    const med = amara.activeMedications.find((m) => m.medicationName === 'Hydroxyurea')!;
    assert.strictEqual(med.dose, '1000mg daily');
    assert.strictEqual(med.id, hydroxyurea.id, 'same id, so the opt-in survives a dose change');
    assert.ok(amara.cardMedicationIds.includes(med.id));
    const push = pushesTo(provider, amara.id).at(-1)!;
    assert.strictEqual(push.body, RECORD_CHANGED_MESSAGE);
    assert.ok(auditManager.getEntries().some((e) => e.action === 'OFFLINE_CARD_MARKED_STALE' && !e.reason?.includes('Hydroxyurea')));

    cards.issue(amara);
    assert.strictEqual(amara.cardStale, false, 'reissuing clears the stale flag');
  });

  test('A discontinued opted-in medication is removed from the opt-ins, and the notification says so', () => {
    const { store, cards, provider, amara, doctor } = setup();
    cards.issue(amara);
    const optedId = amara.activeMedications.find((m) => m.medicationName === 'Hydroxyurea')!.id;
    assert.ok(amara.cardMedicationIds.includes(optedId));
    const { record, resource } = findRecord(store, amara, 'MedicationStatement', 'Hydroxyurea');

    store.updateRecord(record.id, { ...(resource as any), status: 'stopped' }, doctorActor(doctor), {
      consent: consentFor(amara.id, doctor.facilityId, doctor.id), facilityId: doctor.facilityId, reason: 'Discontinued',
    });

    assert.ok(!amara.activeMedications.some((m) => m.medicationName === 'Hydroxyurea'));
    assert.ok(!amara.cardMedicationIds.includes(optedId));
    assert.strictEqual(amara.cardStale, true);
    assert.match(pushesTo(provider, amara.id).at(-1)!.body, /Review and reissue your emergency card\. We removed Hydroxyurea from your card choices because it was discontinued or resolved\./);
    assert.strictEqual(buildCardPayload(amara, { cardVersion: 2 }).e.med, undefined);

    // A resolved opted-in condition is removed the same way
    const cond = findRecord(store, amara, 'Condition', 'Sickle Cell Anemia (HbSS)');
    store.updateRecord(cond.record.id, { ...(cond.resource as any), clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'resolved' }] } },
      doctorActor(doctor), { consent: consentFor(amara.id, doctor.facilityId, doctor.id), facilityId: doctor.facilityId, reason: 'Entered in error as chronic' });
    assert.ok(!amara.cardConditions.includes('Sickle Cell Anemia (HbSS)'));
  });

  test('Corrections are new versions and nothing is deleted', () => {
    const { store, amara, doctor } = setup();
    const { record, resource } = findRecord(store, amara, 'MedicationStatement', 'Folic Acid');
    const updated = store.updateRecord(record.id, { ...(resource as any), dosage: [{ text: '1mg daily (oral)' }] }, doctorActor(doctor), {
      consent: consentFor(amara.id, doctor.facilityId, doctor.id), facilityId: doctor.facilityId, reason: 'Correction',
    });
    assert.strictEqual(updated.record.previousVersionId, record.id);
    assert.strictEqual(updated.record.versionId, record.versionId + 1);
    assert.strictEqual(store.getRecordById(record.id)?.isLatest, false, 'old version kept, no longer latest');
    assert.throws(() => store.deleteRecord(), /HARD_DELETE_PROHIBITED/);
    assert.throws(() => store.updateRecord(record.id, resource as any, doctorActor(doctor), { consent: consentFor(amara.id, doctor.facilityId, doctor.id), facilityId: doctor.facilityId, reason: 'x' }), /latest version/);
  });
});

describe('2. Drafts and who may write', () => {
  test('A draft is not visible in the emergency summary or on the card until a doctor signs it', async () => {
    const { store, engine, amara, doctor, syncResults } = setup();
    const nurse: ActorContext = { userId: 'user-nurse-1', role: 'NURSE', facilityId: doctor.facilityId, isVerifiedStaff: true };
    const before = syncResults.length;
    const draft = store.writeRecord(amara.id, {
      resourceType: 'MedicationStatement', id: crypto.randomUUID(), status: 'active',
      medicationCodeableConcept: { text: 'Synthetic Draft Med' }, subject: { reference: `Patient/${amara.id}` },
      effectiveDateTime: new Date().toISOString(), dosage: [{ text: '10mg daily (oral)' }],
    } as any, nurse, { consent: consentFor(amara.id, doctor.facilityId), facilityId: doctor.facilityId });

    assert.strictEqual(draft.record.status, 'draft');
    assert.strictEqual(syncResults.length, before, 'drafts never reach the card sync');
    assert.ok(!amara.activeMedications.some((m) => m.medicationName === 'Synthetic Draft Med'));
    assert.ok(!store.getPatientRecords(amara.id, patientActor(amara), {}).some(({ record }) => record.id === draft.record.id), 'not in the record view');

    const { grant } = await engine.initiateBreakGlass({
      patient: amara, emergencyCode: 'K7QM-4T9X-2HDP-8W2', actor: doctorActor(doctor), treatingDoctorName: doctor.fullName,
      facilityId: doctor.facilityId, facilityName: 'Synthetic ER', reason: 'UNCONSCIOUS',
    });
    assert.ok(!engine.buildEmergencySummary(amara, grant.id).chronicCare.activeMedications.some((m) => m.medicationName === 'Synthetic Draft Med'));
    assert.throws(() => validateCardSelection(amara, { cardMedicationIds: [`med-${draft.record.id}`] }), /not on your record/);

    // The nurse cannot sign; a doctor at another facility cannot either; the right doctor can.
    assert.throws(() => store.signDraft(draft.record.id, nurse, { consent: consentFor(amara.id, doctor.facilityId), facilityId: doctor.facilityId }), /Forbidden/);
    assert.strictEqual(store.getDrafts(amara.id, nurse, consentFor(amara.id, doctor.facilityId)).length, 1);
    const signed = store.signDraft(draft.record.id, doctorActor(doctor), { consent: consentFor(amara.id, doctor.facilityId, doctor.id), facilityId: doctor.facilityId });

    assert.strictEqual(signed.record.status, 'final');
    assert.strictEqual(signed.record.previousVersionId, draft.record.id);
    assert.strictEqual(store.getRecordById(draft.record.id)?.status, 'draft', 'the draft is kept as the previous version');
    assert.strictEqual(signed.record.signedByClinicianId, doctor.id);
    assert.ok(amara.activeMedications.some((m) => m.medicationName === 'Synthetic Draft Med'));
    assert.ok(engine.buildEmergencySummary(amara, grant.id).chronicCare.activeMedications.some((m) => m.medicationName === 'Synthetic Draft Med'));
    assert.strictEqual(store.getDrafts(amara.id, nurse, consentFor(amara.id, doctor.facilityId)).length, 0);
  });

  test('Only verified doctors at a linked facility write final records; staff only draft', () => {
    const { store, seed, amara, doctor } = setup();
    const resource = () => ({ resourceType: 'Condition', id: crypto.randomUUID(), code: { text: 'Synthetic condition' },
      clinicalStatus: { coding: [{ code: 'active' }] }, verificationStatus: { coding: [{ code: 'confirmed' }] }, subject: { reference: `Patient/${amara.id}` }, recordedDate: new Date().toISOString() } as any);
    const consent = consentFor(amara.id, doctor.facilityId, doctor.id);

    assert.throws(() => store.writeRecord(amara.id, resource(), doctorActor(doctor, false), { consent, facilityId: doctor.facilityId }), /unverified/);
    const elsewhere = seed.facilities.find((f) => f.id !== doctor.facilityId)!.id;
    assert.throws(() => store.writeRecord(amara.id, resource(), doctorActor(doctor), { consent, facilityId: elsewhere }), /not linked to this facility/);
    assert.throws(() => store.writeRecord(amara.id, resource(), { userId: 'u-ro', role: 'RECORDS_OFFICER', facilityId: doctor.facilityId, isVerifiedStaff: false },
      { consent: consentFor(amara.id, doctor.facilityId), facilityId: doctor.facilityId }), /unverified/);
    const ro = store.writeRecord(amara.id, resource(), { userId: 'u-ro', role: 'RECORDS_OFFICER', facilityId: doctor.facilityId, isVerifiedStaff: true },
      { consent: consentFor(amara.id, doctor.facilityId), facilityId: doctor.facilityId });
    assert.strictEqual(ro.record.status, 'draft');
    assert.strictEqual(store.writeRecord(amara.id, resource(), doctorActor(doctor), { consent, facilityId: doctor.facilityId }).record.status, 'final');
    for (const role of ['NURSE', 'RECORDS_OFFICER'] as const) {
      assert.strictEqual(evaluatePolicy({ actor: { userId: 'x', role, isVerifiedStaff: true }, action: 'PATIENT_WRITE_RECORD', targetPatientId: amara.id, activeConsent: consentFor(amara.id, doctor.facilityId) }).allowed, false);
    }
  });

  test('The patient write attempt is still denied', () => {
    const { store, amara, doctor } = setup();
    for (const action of ['PATIENT_WRITE_RECORD', 'PATIENT_DRAFT_RECORD'] as const) {
      const d = evaluatePolicy({ actor: patientActor(amara), action, targetPatientId: amara.id, activeConsent: consentFor(amara.id, doctor.facilityId) });
      assert.strictEqual(d.allowed, false, action);
      assert.strictEqual(d.statusCode, 403);
    }
    assert.throws(() => store.writeRecord(amara.id, { resourceType: 'Condition', id: crypto.randomUUID(), code: { text: 'Self-diagnosed' } } as any,
      patientActor(amara), { facilityId: doctor.facilityId }), /Forbidden/);
  });
});

describe('3. Patient-reported information', () => {
  test('Patient-reported allergies are labelled on the card back and flagged in the QR payload', async () => {
    const { seed } = setup();
    const fatima = seed.patients[4].patient;
    assert.strictEqual(fatima.allergies[0].source, 'patient-reported');
    const issued = new OfflineCardStore().issue(fatima);
    assert.deepStrictEqual(issued.payload.e.alg, [{ s: 'Sulfonamide antibiotics', r: 'Facial swelling', pr: true }]);
    const bundle = await buildOfflineCardBundle(issued, { baseUrl: 'https://demo.example', formattedCode: seed.patients[4].emergencyCode.formattedCode });
    assert.ok(bundle.cardHtml.includes(`Sulfonamide antibiotics</strong>: Facial swelling <em class="pr">(${PATIENT_REPORTED_LABEL})</em>`));
    assert.strictEqual(PATIENT_REPORTED_LABEL, 'Patient-reported, not clinician-verified');
  });
});

describe('4. Record flags', () => {
  test('A patient flag leaves the record unchanged and notifies the author', () => {
    const { store, flags, provider, amara, auditManager } = setup();
    const { record } = findRecord(store, amara, 'Condition', 'Sickle Cell Anemia (HbSS)');
    const snapshot = JSON.stringify(store.getRecordById(record.id));

    const flag = flags.flag(amara.id, record.id, 'This onset date looks wrong to me');
    assert.strictEqual(JSON.stringify(store.getRecordById(record.id)), snapshot, 'record unchanged');
    assert.strictEqual(flag.authorClinicianId, record.signedByClinicianId);
    const push = pushesTo(provider, flag.authorClinicianId).at(-1)!;
    assert.match(push.body, /A patient flagged a Condition record you signed .* as possibly wrong\. Their note: "This onset date looks wrong to me"/);
    const audit = auditManager.getEntries().at(-1)!;
    assert.strictEqual(audit.action, 'PATIENT_FLAGGED_RECORD');
    assert.ok(!audit.reason?.includes('onset date'), 'note is not copied into the audit trail');
    assert.deepStrictEqual(flags.forAuthor(flag.authorClinicianId).map((f) => f.id), [flag.id]);

    assert.throws(() => flags.flag('someone-else', record.id, 'Not my record at all'), /Record not found/);
    assert.throws(() => flags.flag(amara.id, record.id, 'no'), /at least 5/);
  });
});

describe('5. Lost card over HTTP: revoke, reissue required, scanners told on sync', () => {
  const PORT = 40000 + Math.floor(Math.random() * 1000);
  const base = `http://localhost:${PORT}`;
  let server: ChildProcess;
  const seed = generateSeedData();
  const patient = seed.patients[1].patient;
  const clinician = seed.clinicians[2];
  const post = (path: string, body: unknown, token?: string) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });

  before(async () => {
    server = spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('server did not start');
  });
  after(() => { server?.kill(); });

  test('A revoked card shows as revoked in offline-scan sync responses', async () => {
    const card = await (await fetch(`${base}/api/patients/${patient.id}/offline-card`)).json();
    assert.strictEqual(card.cardVersion, 1);
    assert.strictEqual((await post(`/api/patients/${patient.id}/offline-card/revoke`, { reason: '' })).status, 400);

    const revoked = await post(`/api/patients/${patient.id}/offline-card/revoke`, { reason: 'lost' });
    assert.strictEqual(revoked.status, 200);
    assert.deepStrictEqual((await revoked.json()).needsReissue, true);
    const again = await fetch(`${base}/api/patients/${patient.id}/offline-card`);
    assert.strictEqual(again.status, 409, 'no silent replacement');
    assert.match((await again.json()).error, /revoked\. Reissue it/);
    assert.strictEqual((await post(`/api/patients/${patient.id}/offline-card/revoke`, { reason: 'lost' })).status, 404);
    assert.strictEqual((await fetch(`${base}/emergency/offline-card?patientId=${patient.id}`)).status, 409);

    // A scanner that scanned v1 offline learns it is revoked when it syncs
    const kp = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair;
    const totp = (await (await fetch(`${base}/api/demo/totp/${clinician.id}`)).json()).code;
    const login = await (await post('/api/clinician/login', { clinicianId: clinician.id, totp, devicePublicJwk: await globalThis.crypto.subtle.exportKey('jwk', kp.publicKey) })).json();
    const ev = await signScanEvent({ eventId: crypto.randomUUID(), cardSub: patient.id, cardVersion: 1, cardKid: 'kid', reason: 'UNCONSCIOUS', scannedAt: new Date().toISOString(), pass: login.pass }, kp.privateKey);
    const { results } = await (await post('/api/emergency/offline-scans', { events: [ev] })).json();
    assert.deepStrictEqual([results[0].status, results[0].cardStatus], ['accepted', 'revoked']);

    const reissued = await (await post(`/api/patients/${patient.id}/offline-card`, {})).json();
    assert.strictEqual(reissued.cardVersion, 2);
    assert.strictEqual((await fetch(`${base}/api/patients/${patient.id}/offline-card`)).status, 200);

    const { logs } = await (await fetch(`${base}/api/patients/${patient.id}/access-log`)).json();
    assert.ok(logs.some((l: { action: string }) => l.action === 'OFFLINE_CARD_REVOKED'));
    assert.strictEqual((await (await fetch(`${base}/api/audit/verify`)).json()).valid, true);
  });

  test('Patients flag records over HTTP; the signing clinician sees the flag', async () => {
    const { timeline } = await (await fetch(`${base}/api/patients/${patient.id}/timeline`)).json();
    const target = timeline.find((t: { resourceType: string }) => t.resourceType === 'Condition');
    const res = await post(`/api/patients/${patient.id}/records/${target.id}/flag`, { note: 'I was never told about this diagnosis' });
    assert.strictEqual(res.status, 200);
    const { flag } = await res.json();
    assert.strictEqual((await post(`/api/patients/${seed.patients[2].patient.id}/records/${target.id}/flag`, { note: 'Not my record either' })).status, 404);

    const author = seed.clinicians.find((c) => c.id === flag.authorClinicianId)!;
    const totp = (await (await fetch(`${base}/api/demo/totp/${author.id}`)).json()).code;
    const { token } = await (await post('/api/clinician/login', { clinicianId: author.id, totp })).json();
    const { flags } = await (await fetch(`${base}/api/clinician/record-flags`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.ok(flags.some((f: { id: string }) => f.id === flag.id));
  });
});
