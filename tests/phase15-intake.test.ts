// Phase 15: no double entry. FHIR import from facility EMRs (client credentials, all-or-nothing, idempotent),
// the OpenMRS connector (fixtures, no live calls), and AI intake drafts that only a doctor can sign.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createRuntime } from '../src/lib/runtime.ts';
import { createMemoryPersistence } from '../src/lib/data/memory/persistence.ts';
import { createPortalApi } from '../src/lib/site/portalApi.ts';
import { generateTotp } from '../src/lib/auth/security.ts';
import { OpenMrsConnector } from '../src/lib/integrations/emr/OpenMrsConnector.ts';
import { createIntakeAdapters, HttpLlmAdapter, type LlmAdapter } from '../src/lib/intake/adapters.ts';
import { IntakeService } from '../src/lib/intake/intakeService.ts';
import { SecureDocumentManager } from '../src/lib/clinical/fileUpload.ts';
import { TestPatternScannerAdapter } from '../src/lib/clinical/virusScanners.ts';

const rt = await createRuntime(createMemoryPersistence());
const api = createPortalApi({ ...rt, notifications: rt.consoleProvider, offlineCards: rt.offlineCardStore, dataDir: path.join(os.tmpdir(), 'medistry-phase15') });
let base = '';
const server = http.createServer(async (req, res) => {
  if (!(await api(req, res, new URL(req.url || '/', 'http://localhost')))) { res.writeHead(404); res.end('{}'); }
});
after(() => { server.close(); });

const FACILITY = 'fac-luth-001';
const patient = rt.seedData.patients.map((p) => p.patient).find((p) => p.primaryFacilityId === FACILITY)!;
const otherPatient = rt.seedData.patients.map((p) => p.patient).find((p) => p.primaryFacilityId && p.primaryFacilityId !== FACILITY)!;
const doctor = rt.seedData.clinicians.find((c) => c.facilityId === FACILITY && c.status === 'VERIFIED')!;
const info = { ipAddress: '127.0.0.1', userAgent: 'test' };

async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, type: r.headers.get('content-type') || '', body: await r.json().catch(() => ({})) as any };
}
const recordsOf = (patientId: string) => (rt.clinicalStore as any).patientIndex.get(patientId)?.length ?? 0;

let importToken = '';
let clientRowId = '';
let doctorToken = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // A facility admin (demo admin, demo authenticator) creates an API client; the EMR exchanges it for a token.
  const adminId = `admin-${FACILITY}-demo`;
  const login = await call('POST', '/api/admin/login', { adminId, totp: generateTotp(rt.staff.demoTotpSecret(adminId)!) });
  assert.strictEqual(login.status, 200, JSON.stringify(login.body));
  const created = await call('POST', '/api/admin/facility-api-clients', { name: 'Synthetic KenyaEMR' }, { Authorization: `Bearer ${login.body.token}` });
  assert.strictEqual(created.status, 200, JSON.stringify(created.body));
  clientRowId = created.body.id;
  assert.ok(!JSON.stringify(rt.apiClients.list(rt.accounts.get(adminId)!)).includes(created.body.clientSecret), 'the secret is never stored or listed');
  const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: created.body.clientId, client_secret: created.body.clientSecret });
  const tok = await fetch(`${base}/api/fhir/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
  const t = await tok.json() as any;
  assert.deepStrictEqual([tok.status, t.token_type, t.expires_in, t.scope], [200, 'Bearer', 300, 'fhir.import']);
  importToken = t.access_token;
  const bad = await fetch(`${base}/api/fhir/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: created.body.clientId, client_secret: 'wrong' }) });
  assert.strictEqual(bad.status, 401);

  // The doctor signs in (demo authenticator) and has the patient's consent.
  const dl = await call('POST', '/api/clinician/login', { clinicianId: doctor.id, totp: generateTotp(rt.staff.demoTotpSecret(doctor.id)!) });
  doctorToken = dl.body.token;
  const req = rt.consentManager.createAccessRequest({
    patientId: patient.id, clinicianId: doctor.id, clinicianName: doctor.fullName, facilityId: FACILITY, facilityName: 'LUTH',
    requestedScopes: ['all'], durationPreset: 'SEVEN_DAYS', clinicalReason: 'Synthetic follow-up',
  });
  rt.consentManager.approveInApp(req.requestId, patient.id);
});

const importBundle = (bundle: unknown, token = importToken) => call('POST', '/api/fhir/import', bundle, { Authorization: `Bearer ${token}`, 'Content-Type': 'application/fhir+json' });

function validBundle(suffix = '') {
  return {
    resourceType: 'Bundle', type: 'transaction',
    entry: [
      { fullUrl: 'urn:uuid:pat', resource: { resourceType: 'Patient', identifier: [{ system: 'urn:medistry:patient-id', value: patient.id }, { system: 'urn:synthetic:luth-mrn', value: 'LUTH-SYN-42' }] } },
      { fullUrl: 'urn:uuid:doc', resource: { resourceType: 'Practitioner', identifier: [{ system: 'urn:synthetic:licence', value: doctor.licenseNumber }] } },
      { resource: { resourceType: 'Encounter', identifier: [{ system: 'urn:synthetic:enc', value: 'E-1' }], status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' }, subject: { reference: 'urn:uuid:pat' }, period: { start: '2026-11-10T09:00:00Z' }, participant: [{ individual: { reference: 'urn:uuid:doc' } }], diagnosis: [{ condition: { display: `Synthetic signed visit diagnosis${suffix}` }, rank: 1 }] } },
      { resource: { resourceType: 'Condition', identifier: [{ system: 'urn:synthetic:cond', value: 'C-1' }], code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10', code: 'I10', display: 'Synthetic essential hypertension' }] }, subject: { reference: 'urn:uuid:pat' }, recorder: { reference: 'urn:uuid:doc' }, recordedDate: '2026-11-10' } },
      { resource: { resourceType: 'AllergyIntolerance', identifier: [{ system: 'urn:synthetic:alg', value: 'A-1' }], code: { text: 'Synthetic latex' }, patient: { reference: 'urn:uuid:pat' }, recorder: { reference: 'urn:uuid:doc' } } },
      { resource: { resourceType: 'MedicationStatement', identifier: [{ system: 'urn:synthetic:med', value: 'M-1' }], status: 'active', medicationCodeableConcept: { text: 'Synthetic lisinopril' }, subject: { reference: 'urn:uuid:pat' }, informationSource: { reference: 'urn:uuid:doc' }, dosage: [{ text: '10 mg daily' }] } },
      { resource: { resourceType: 'Observation', identifier: [{ system: 'urn:synthetic:obs', value: 'O-1' }], status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '8480-6', display: 'Systolic blood pressure' }] }, subject: { reference: 'urn:uuid:pat' }, effectiveDateTime: '2026-11-10T09:05:00Z', valueQuantity: { value: 142, unit: 'mmHg' }, performer: [{ reference: 'urn:uuid:doc' }] } },
      { resource: { resourceType: 'DiagnosticReport', identifier: [{ system: 'urn:synthetic:rep', value: 'R-1' }], status: 'final', code: { text: 'Synthetic lipid panel' }, subject: { reference: 'urn:uuid:pat' }, conclusion: 'Synthetic conclusion', resultsInterpreter: [{ reference: 'urn:uuid:doc' }] } },
      { resource: { resourceType: 'DocumentReference', identifier: [{ system: 'urn:synthetic:doc', value: 'D-1' }], status: 'current', subject: { reference: 'urn:uuid:pat' }, content: [{ attachment: { contentType: 'application/pdf', title: 'referral.pdf', data: Buffer.from('%PDF-1.4 synthetic referral').toString('base64') } }], author: [{ reference: 'urn:uuid:doc' }] } },
    ],
  };
}

describe('FHIR import', () => {
  test('A valid bundle imports (records filed as emr-import with the facility as origin, signed by the verified author)', async () => {
    const before = recordsOf(patient.id);
    const r = await importBundle(validBundle());
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.match(r.type, /application\/fhir\+json/);
    assert.strictEqual(r.body.type, 'transaction-response');
    assert.strictEqual(r.body.entry.length, 7);
    assert.ok(r.body.entry.every((e: any) => e.response.status === '201 Created'));
    assert.strictEqual(recordsOf(patient.id), before + 7);
    const conditions = rt.clinicalStore.getLatestFinalRecords(patient.id, 'Condition').filter(({ record }) => record.source === 'emr-import');
    assert.strictEqual(conditions.length, 1);
    const [{ record, resource }] = conditions;
    assert.deepStrictEqual([record.status, record.originFacilityId, record.signedByClinicianId], ['final', FACILITY, doctor.id]);
    assert.strictEqual((resource as any).code.text, 'Synthetic essential hypertension', 'display filled from the coding');
    assert.strictEqual((resource as any).subject.reference, `Patient/${patient.id}`);
    assert.ok(patient.chronicConditions.includes('Synthetic essential hypertension'), 'signed import updates the card content');
    assert.ok(rt.auditManager.getEntries().some((e) => e.action === 'FHIR_BUNDLE_IMPORTED' && e.actorId.startsWith('api-client:')));
    assert.strictEqual(rt.patientLinks.find(FACILITY, 'urn:synthetic:luth-mrn', 'LUTH-SYN-42'), patient.id, 'the facility MRN is now linked');
  });

  test('Re-importing the same bundle makes no duplicates; changed content becomes a new version', async () => {
    const before = recordsOf(patient.id);
    const again = await importBundle(validBundle());
    assert.strictEqual(again.status, 200);
    assert.ok(again.body.entry.every((e: any) => e.response.status === '200 OK'));
    assert.strictEqual(recordsOf(patient.id), before, 'no duplicates');
    const changed = await importBundle(validBundle(' (corrected)'));
    const enc = changed.body.entry[0].response;
    assert.match(enc.location, /^Encounter\/.+\/_history\/2$/, 'changed encounter is version 2');
    assert.strictEqual(recordsOf(patient.id), before + 1);
    // The MRN alone now identifies the patient for this facility.
    const byMrn = await importBundle({ resourceType: 'Bundle', type: 'collection', entry: [
      { fullUrl: 'urn:uuid:p', resource: { resourceType: 'Patient', identifier: [{ system: 'urn:synthetic:luth-mrn', value: 'LUTH-SYN-42' }] } },
      { resource: { resourceType: 'Observation', id: 'src-obs-77', status: 'final', code: { text: 'Synthetic weight' }, subject: { reference: 'urn:uuid:p' }, valueQuantity: { value: 70, unit: 'kg' } } },
    ] });
    assert.strictEqual(byMrn.status, 200, JSON.stringify(byMrn.body));
  });

  test('An invalid bundle returns an OperationOutcome and nothing is saved', async () => {
    const before = recordsOf(patient.id);
    const audits = rt.auditManager.getEntries().length;
    const bundle = validBundle('-x');
    bundle.entry[6].resource.status = 'done'; // not an Observation status
    (bundle.entry[6].resource as any).code.coding[0].code = 'NOT-LOINC';
    bundle.entry.push({ resource: { resourceType: 'Immunization', id: 'x' } } as any);
    bundle.entry.push({ resource: { resourceType: 'Condition', identifier: [{ system: 'urn:synthetic:cond', value: 'C-9' }], subject: { reference: 'urn:uuid:pat' } } } as any);
    const r = await importBundle(bundle);
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.body.resourceType, 'OperationOutcome');
    const diag = r.body.issue.map((i: any) => i.diagnostics).join(' | ');
    for (const expect of [/Observation\.status must be one of/, /not a valid code for http:\/\/loinc\.org/, /Immunization is not supported/, /code needs text or a coding/]) assert.match(diag, expect);
    assert.ok(r.body.issue.every((i: any) => i.severity === 'error' && Array.isArray(i.expression)));
    assert.strictEqual(recordsOf(patient.id), before, 'all or nothing: the valid entries were not saved either');
    assert.strictEqual(rt.auditManager.getEntries().slice(audits).filter((e) => e.action.startsWith('CLINICAL_RECORD_IMPORTED')).length, 0);
    assert.ok(rt.auditManager.getEntries().slice(audits).some((e) => e.action === 'FHIR_BUNDLE_REJECTED'));
  });

  test('Patients are never created: no identity match, a mismatched birth date, or an unconnected facility is rejected', async () => {
    const patients = rt.patientsById.size;
    const unknown = await importBundle({ resourceType: 'Bundle', type: 'collection', entry: [
      { fullUrl: 'urn:uuid:n', resource: { resourceType: 'Patient', identifier: [{ system: 'urn:synthetic:luth-mrn', value: 'NO-SUCH-MRN' }], name: [{ family: 'Synthetic' }] } },
      { resource: { resourceType: 'Condition', id: 'c1', code: { text: 'x' }, subject: { reference: 'urn:uuid:n' } } },
    ] });
    assert.strictEqual(unknown.status, 422);
    assert.match(unknown.body.issue[0].diagnostics, /No identity match .* never creates patients/);
    assert.strictEqual(rt.patientsById.size, patients);
    const dob = await importBundle({ resourceType: 'Bundle', type: 'collection', entry: [
      { fullUrl: 'urn:uuid:p', resource: { resourceType: 'Patient', identifier: [{ system: 'urn:medistry:patient-id', value: patient.id }], birthDate: '1900-01-01' } },
      { resource: { resourceType: 'Condition', id: 'c2', code: { text: 'x' }, subject: { reference: 'urn:uuid:p' } } },
    ] });
    assert.match(dob.body.issue[0].diagnostics, /birthDate does not match/);
    const other = await importBundle({ resourceType: 'Bundle', type: 'collection', entry: [
      { resource: { resourceType: 'Condition', id: 'c3', code: { text: 'x' }, subject: { reference: `Patient/${otherPatient.id}` } } },
    ] });
    assert.strictEqual(other.status, 422);
    assert.match(other.body.issue[0].diagnostics, /not connected to the patient/);
  });

  test('Without a token, or after the client is revoked, imports are refused', async () => {
    assert.strictEqual((await importBundle(validBundle(), 'not-a-token')).status, 401);
    assert.strictEqual((await importBundle(validBundle(), doctorToken)).status, 401, 'a clinician session is not an API client token');
    const admin = rt.accounts.get(`admin-${FACILITY}-demo`)!;
    const { client, clientSecret } = await rt.apiClients.create(admin, { name: 'Synthetic second EMR' }, info);
    const t = (await (await fetch(`${base}/api/fhir/token`, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${client.clientId}:${clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' })).json() as any).access_token;
    rt.apiClients.revoke(admin, client.id, info);
    assert.strictEqual((await importBundle(validBundle(), t)).status, 401, 'revoked at once');
    assert.ok(clientRowId);
  });

  test('A bundle without an author creates drafts that are not in the emergency summary until a doctor signs them', async () => {
    const r = await importBundle({ resourceType: 'Bundle', type: 'collection', entry: [
      { resource: { resourceType: 'Encounter', identifier: [{ system: 'urn:synthetic:enc', value: 'E-NOAUTHOR' }], status: 'finished', class: { code: 'EMER' }, subject: { reference: `Patient/${patient.id}` }, period: { start: new Date().toISOString() }, diagnosis: [{ condition: { display: 'Synthetic unsigned imported diagnosis' }, rank: 1 }] } },
    ] });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.entry[0].response.outcome.issue[0].diagnostics, /Saved as a draft/);
    const { grant } = await rt.emergencyEngine.initiateBreakGlass({
      patient, emergencyCode: rt.codeByPatient.get(patient.id)!.formattedCode,
      actor: { userId: doctor.userId, role: 'DOCTOR', clinicianId: doctor.id, facilityId: FACILITY, isVerifiedClinician: true },
      treatingDoctorName: doctor.fullName, facilityId: FACILITY, facilityName: 'LUTH', reason: 'OTHER', reasonDetails: 'Synthetic',
    });
    const summary = () => JSON.stringify(rt.emergencyEngine.buildEmergencySummary(patient, grant.id));
    assert.ok(!summary().includes('Synthetic unsigned imported diagnosis'), 'a draft is not in the emergency summary');
    const drafts = await call('GET', `/api/clinician/patients/${patient.id}/drafts`, undefined, { Authorization: `Bearer ${doctorToken}` });
    const draft = drafts.body.drafts.find((d: any) => d.resource.diagnosis?.[0]?.condition?.display === 'Synthetic unsigned imported diagnosis');
    assert.deepStrictEqual([draft.source, draft.originFacilityId], ['emr-import', FACILITY]);
    const signed = await call('POST', `/api/clinician/drafts/${draft.recordId}/sign`, {}, { Authorization: `Bearer ${doctorToken}` });
    assert.deepStrictEqual([signed.status, signed.body.status, signed.body.versionId, signed.body.previousVersionId], [200, 'final', 2, draft.recordId]);
    assert.ok(summary().includes('Synthetic unsigned imported diagnosis'), 'visible once signed');
  });
});

describe('OpenMRS connector (fixtures, no live calls)', () => {
  const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/openmrs-fhir2.json', import.meta.url), 'utf8'));
  const BASE = 'https://emr.synthetic.example/openmrs';

  test('Pulls through /ws/fhir2/R4 with Basic auth, follows same-server paging, and maps resources for import', async () => {
    const calls: Array<{ url: string; auth: string }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), auth: (init.headers as Record<string, string>).Authorization });
      const u = new URL(String(url));
      const type = u.pathname.split('/').pop()!;
      const pages = fixtures[type];
      const page = u.searchParams.get('_getpages') === 'page2' ? 1 : 0;
      return new Response(JSON.stringify(pages[page]).replaceAll('{BASE}', BASE), { status: 200 });
    }) as unknown as typeof fetch;
    const connector = new OpenMrsConnector({ baseUrl: BASE, username: 'synthetic-user', password: 'synthetic-pass', practitionerMap: { 'omrs-provider-uuid-1': doctor.id } }, { fetch: fakeFetch });
    const bundle = await connector.pullPatientBundle({ emrPatientId: 'omrs-patient-uuid-1', medistryPatientId: patient.id }, '2026-09-01T00:00:00Z');

    assert.strictEqual(calls[0].url, `${BASE}/ws/fhir2/R4/Encounter?patient=omrs-patient-uuid-1&_lastUpdated=ge2026-09-01T00%3A00%3A00Z`);
    assert.strictEqual(calls[0].auth, `Basic ${Buffer.from('synthetic-user:synthetic-pass').toString('base64')}`);
    assert.ok(calls.some((c) => c.url.includes('_getpages=page2')), 'next page followed');
    assert.ok(!calls.some((c) => c.url.includes('elsewhere.example.org')), 'a next link to another server is not followed');
    assert.deepStrictEqual([...new Set(calls.map((c) => new URL(c.url).pathname.split('/').pop()))], ['Encounter', 'Condition', 'AllergyIntolerance', 'Observation', 'MedicationRequest', 'DiagnosticReport']);

    const byType = (t: string) => bundle.entry.map((e) => e.resource).filter((r) => r.resourceType === t);
    const [enc1, enc2] = byType('Encounter');
    assert.strictEqual(enc1.subject.reference, `Patient/${patient.id}`, 'subject rewritten to the Medistry patient');
    assert.deepStrictEqual(enc1.identifier, [{ system: `${BASE}/ws/fhir2/R4/Encounter`, value: 'omrs-enc-uuid-1' }], 'OpenMRS UUID becomes the import identifier');
    assert.strictEqual(enc1.class.code, 'AMB', 'configured default class when the server sends none');
    assert.strictEqual(enc2.class.code, 'IMP', 'a class the server sends is kept');
    assert.deepStrictEqual(enc1.participant, [{ individual: { reference: `Practitioner/${doctor.id}` } }], 'provider mapped through config');
    assert.ok(!('location' in enc1) && !('meta' in enc1) && !('text' in enc1), 'location UUIDs, meta and narrative HTML dropped');
    const [med] = byType('MedicationStatement');
    assert.deepStrictEqual([med.status, med.medicationCodeableConcept.text, med.dosage[0].text, med.informationSource], ['stopped', 'Synthetic amlodipine 5mg', 'Once daily', undefined], 'MedicationRequest -> MedicationStatement');
    assert.strictEqual(byType('MedicationRequest').length, 0);
    const [obs] = byType('Observation');
    assert.deepStrictEqual([obs.code.coding[0].system, obs.code.coding[0].code, 'encounter' in obs], ['https://cielterminology.org', '5085', false], 'concept codes passed through (TODO: site mapping)');

    // The pulled bundle goes through the same import pipeline.
    const admin = rt.accounts.get(`admin-${FACILITY}-demo`)!;
    const { client } = await rt.apiClients.create(admin, { name: 'Synthetic OpenMRS pull' }, info);
    const result = await rt.fhirImport.importBundle(bundle, { id: client.id, clientId: client.clientId, facilityId: FACILITY }, info);
    assert.strictEqual(result.response.entry.length, 6);
    assert.deepStrictEqual([result.summary.created, result.summary.drafts], [6, 4], 'mapped provider (encounter 1, condition): final; no or unknown author: draft');
  });
});

describe('AI intake (paper hospitals)', () => {
  const note = 'Complaint: fever and headache for 3 days\nBP 130/85, Temp 38.6 C\nDiagnosis: Synthetic malaria\nAllergy: Synthetic penicillin (severe)\nMedications: Synthetic artemether 80/480mg twice daily, Synthetic paracetamol';
  const auth = () => ({ Authorization: `Bearer ${doctorToken}` });

  test('The fake LLM returns drafts with source spans; low-confidence fields are flagged; nothing is signed', async () => {
    const finalBefore = rt.clinicalStore.getLatestFinalRecords(patient.id, 'Condition').length;
    const r = await call('POST', '/api/clinician/intake', { patientId: patient.id, kind: 'text', text: note }, auth());
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const v = r.body;
    assert.deepStrictEqual([v.status, v.adapters.llm, v.adapters.model], ['review', 'fake-deterministic-v1', 'fake-deterministic-v1']);
    assert.strictEqual(v.sourceText, note);
    assert.deepStrictEqual(v.proposals.map((p: any) => p.resourceType), ['Encounter', 'Observation', 'Observation', 'Condition', 'AllergyIntolerance', 'MedicationStatement', 'MedicationStatement']);
    for (const p of v.proposals) {
      assert.strictEqual(p.state, 'draft');
      for (const f of p.fields) assert.strictEqual(note.slice(f.span.start, f.span.end), f.span.text, `span for ${f.path}`);
    }
    const allergy = v.proposals.find((p: any) => p.resourceType === 'AllergyIntolerance');
    assert.deepStrictEqual(allergy.fields.map((f: any) => [f.path, f.value, f.span.text]), [['code.text', 'Synthetic penicillin', 'Synthetic penicillin'], ['reaction[0].severity', 'severe', '(severe)']]);
    const paracetamol = v.proposals.find((p: any) => p.fields[0].value === 'Synthetic paracetamol');
    assert.strictEqual(paracetamol.fields[0].lowConfidence, true, 'no dose: flagged');
    assert.strictEqual(v.lowConfidenceFields, 1);
    // Drafts only: not in the record, the summary or the card.
    for (const p of v.proposals) assert.strictEqual(rt.clinicalStore.getRecordById(p.recordId)!.status, 'draft');
    assert.strictEqual(rt.clinicalStore.getLatestFinalRecords(patient.id, 'Condition').length, finalBefore, 'never auto-signed');
    assert.ok(!patient.allergies.some((a) => a.substance === 'Synthetic penicillin'));
    const created = rt.auditManager.getEntries().find((e) => e.action === 'AI_DRAFT_CREATED' && e.resourceId === v.intakeId)!;
    assert.match(created.reason!, /fake-deterministic-v1/);
    assert.ok(!rt.auditManager.getEntries().some((e) => e.action === 'AI_DRAFT_SIGNED' && e.resourceId === v.intakeId));
  });

  test('The doctor edits, discards and signs all: signed records are new versions, with audit entries naming the adapter', async () => {
    const v = (await call('POST', '/api/clinician/intake', { patientId: patient.id, kind: 'text', text: 'Diagnosis: Synthetic typhoid\nAllergy: Synthetic aspirin\nMedications: Synthetic ciprofloxacin' }, auth())).body;
    const [cond, allergy, med] = v.proposals;
    const edited = await call('POST', `/api/clinician/intake/${v.intakeId}/drafts/${med.recordId}`, { fields: { 'dosage[0].text': '500 mg twice daily for 7 days' } }, auth());
    const medNow = edited.body.proposals.find((p: any) => p.key === med.key);
    assert.deepStrictEqual([medNow.versionId, medNow.resource.dosage[0].text], [2, '500 mg twice daily for 7 days'], 'edit = new draft version');
    assert.strictEqual(rt.clinicalStore.getRecordById(med.recordId)!.isLatest, false, 'the first draft is kept');
    assert.strictEqual((await call('POST', `/api/clinician/intake/${v.intakeId}/drafts/${cond.recordId}`, { fields: { 'subject.reference': 'Patient/x' } }, auth())).status, 400, 'only known fields');
    await call('POST', `/api/clinician/intake/${v.intakeId}/drafts/${cond.recordId}/discard`, { reason: 'Synthetic: not this visit' }, auth());

    const signed = await call('POST', `/api/clinician/intake/${v.intakeId}/sign`, {}, auth());
    assert.strictEqual(signed.status, 200, JSON.stringify(signed.body));
    assert.strictEqual(signed.body.status, 'signed');
    const states = Object.fromEntries(signed.body.proposals.map((p: any) => [p.resourceType, p.state]));
    assert.deepStrictEqual(states, { Condition: 'discarded', AllergyIntolerance: 'signed', MedicationStatement: 'signed' });
    const signedAllergy = rt.clinicalStore.getRecordById(signed.body.proposals.find((p: any) => p.key === allergy.key).recordId)!;
    assert.deepStrictEqual([signedAllergy.status, signedAllergy.source, signedAllergy.versionId, signedAllergy.previousVersionId, signedAllergy.signedByClinicianId], ['final', 'ai-draft', 2, allergy.recordId, doctor.id]);
    const signedMed = rt.clinicalStore.getRecordById(signed.body.proposals.find((p: any) => p.key === med.key).recordId)!;
    assert.strictEqual(signedMed.versionId, 3, 'draft v1, edited draft v2, signed v3');
    assert.ok(patient.allergies.some((a) => a.substance === 'Synthetic aspirin'), 'signed allergy reaches the card content');
    assert.ok(!patient.chronicConditions.includes('Synthetic typhoid'), 'the discarded draft never does');
    const audit = rt.auditManager.getEntries().find((e) => e.action === 'AI_DRAFT_SIGNED' && e.resourceId === v.intakeId)!;
    assert.match(audit.reason!, /2 AI draft\(s\) signed by the doctor \(1 edited first\); proposed by fake-deterministic-v1/);
    assert.ok(rt.auditManager.getEntries().some((e) => e.action === 'CLINICAL_DRAFT_SIGNED_ALLERGYINTOLERANCE' && e.resourceId === signedAllergy.id));
    assert.strictEqual((await call('POST', `/api/clinician/intake/${v.intakeId}/sign`, {}, auth())).status, 409, 'nothing left to sign');
  });

  test('Photo and voice need a configured OCR / speech-to-text provider; the upload is still checked first', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9]).toString('base64');
    const photo = await call('POST', '/api/clinician/intake', { patientId: patient.id, kind: 'photo', file: { filename: 'note.jpg', mimeType: 'image/jpeg', contentBase64: jpeg } }, auth());
    assert.deepStrictEqual([photo.status, /No OCR provider/.test(photo.body.error)], [503, true]);
    const fakeAudio = Buffer.from('MZ not audio').toString('base64');
    const voice = await call('POST', '/api/clinician/intake', { patientId: patient.id, kind: 'voice', file: { filename: 'v.webm', mimeType: 'audio/webm', contentBase64: fakeAudio } }, auth());
    assert.deepStrictEqual([voice.status, /not WebM, Ogg, WAV, MP4 or MP3/.test(voice.body.error)], [400, true]);
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(32)]).toString('base64');
    const voice2 = await call('POST', '/api/clinician/intake', { patientId: patient.id, kind: 'voice', file: { filename: 'v.webm', mimeType: 'audio/webm;codecs=opus', contentBase64: webm } }, auth());
    assert.deepStrictEqual([voice2.status, /No speech-to-text provider/.test(voice2.body.error)], [503, true]);
    // Without consent: refused.
    const noConsent = await call('POST', '/api/clinician/intake', { patientId: otherPatient.id, kind: 'text', text: 'Diagnosis: x' }, auth());
    assert.strictEqual(noConsent.status, 403);
  });

  test('Model output is checked: spans must be in the source, unknown fields are dropped; real models are gated', async () => {
    const lying: LlmAdapter = {
      name: 'test-model',
      structure: async () => ({ model: 'test-model-1', resources: [{ resourceType: 'Condition', fields: [
        { path: 'code.text', value: 'Synthetic invented diagnosis', span: { start: 0, end: 5, text: 'never in the note' }, confidence: 0.99 },
        { path: 'verificationStatus', value: 'confirmed', span: { start: 0, end: 4, text: 'Note' }, confidence: 0.99 },
      ] }] }),
    };
    const svc = new IntakeService({ clinicalStore: rt.clinicalStore, auditManager: rt.auditManager, documents: new SecureDocumentManager(new TestPatternScannerAdapter()), ocr: createIntakeAdapters({}).ocr, stt: createIntakeAdapters({}).stt, llm: () => lying });
    const consent = rt.consentManager.resolveActiveConsent(patient.id, doctor.id, FACILITY) as any;
    const v = await svc.create({ patient, kind: 'text', text: 'Note: patient well.' }, { userId: doctor.userId, role: 'DOCTOR', clinicianId: doctor.id, facilityId: FACILITY, isVerifiedClinician: true }, consent, info);
    const [p] = v.proposals;
    assert.deepStrictEqual(p.fields.map((f: any) => [f.path, f.span, f.confidence, f.lowConfidence]), [['code.text', null, 0, true]], 'unverifiable span: confidence 0 and flagged; unknown path dropped');
    assert.strictEqual(rt.clinicalStore.getRecordById(p.recordId)!.status, 'draft');

    assert.match(createIntakeAdapters({}).llm().name, /fake-deterministic/);
    const gated = { INTAKE_LLM_PROVIDER: 'http', INTAKE_LLM_URL: 'https://llm.synthetic.example/intake', INTAKE_LLM_API_KEY: 'k' };
    assert.throws(() => createIntakeAdapters({ ...gated, DEMO_MODE: '0' }).llm(), /in-country or self-hosted/);
    assert.ok(createIntakeAdapters({ ...gated, DEMO_MODE: '0', LLM_IN_COUNTRY_APPROVED: '1' }).llm() instanceof HttpLlmAdapter);
    assert.throws(() => createIntakeAdapters({ INTAKE_LLM_PROVIDER: 'somevendor' }).llm(), /must be fake, or http/);
  });
});
