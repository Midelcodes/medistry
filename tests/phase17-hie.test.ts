// Phase 17: national health information exchanges (mocked connectors, no live calls), labs and pharmacies.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRuntime } from '../src/lib/runtime.ts';
import { createMemoryPersistence } from '../src/lib/data/memory/persistence.ts';
import { createPortalApi } from '../src/lib/site/portalApi.ts';
import { generateTotp, generateTotpSecret, fromRfc4648Base32 } from '../src/lib/auth/security.ts';
import { evaluatePolicy } from '../src/lib/policy/enforcer.ts';
import { renderSms, SUPPORTED_LOCALES } from '../src/lib/i18n/translations.ts';
import { FhirHieConnector, HieNotConfigured, HieTransientError, KenyaShrConnector, NigeriaHieConnector, hieConfigFromEnv, type HieConnector } from '../src/lib/integrations/hie/HieConnector.ts';
import { OUTBOX_MAX_ATTEMPTS, OUTBOX_RETRY_BASE_MS } from '../src/lib/integrations/hie/nationalExchange.ts';

/** A stand-in exchange: records pushes; can fail transiently or permanently; returns a synthetic summary. */
class MockExchange implements HieConnector {
  readonly name = 'mock-exchange';
  readonly country = 'NG';
  pushes: Array<Record<string, any>> = [];
  queries = 0;
  mode: 'ok' | 'transient' | 'permanent' = 'ok';
  patientIdentifierSystem(idType: string) { return idType === 'NIN' ? 'urn:test:exchange:nin' : null; }
  async pushRecord(r: Record<string, any>) {
    if (this.mode === 'transient') throw new HieTransientError('HTTP 503');
    if (this.mode === 'permanent') throw Object.assign(new Error('HTTP 422'), { retryable: false });
    this.pushes.push(r);
    return { remoteId: `remote-${this.pushes.length}` };
  }
  async queryPatientSummary() {
    this.queries++;
    return { resources: [{ resourceType: 'Condition', code: { text: 'Synthetic condition held by the exchange' } }] };
  }
  getStatus() { return { name: this.name, country: this.country, configured: true, baseUrl: 'https://exchange.sandbox.test', facilityCode: 'SYN-FAC-1' }; }
}

const rt = await createRuntime(createMemoryPersistence());
const exchange = new MockExchange();
rt.connectors.set('NG', exchange);
const api = createPortalApi({ ...rt, notifications: rt.consoleProvider, offlineCards: rt.offlineCardStore, dataDir: path.join(os.tmpdir(), 'medistry-phase17') });
let base = '';
const server = http.createServer(async (req, res) => {
  if (!(await api(req, res, new URL(req.url || '/', 'http://localhost')))) { res.writeHead(404); res.end('{}'); }
});
async function call(method: string, p: string, body?: unknown, token?: string, headers: Record<string, string> = {}) {
  const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) as any };
}

const FACILITY = 'fac-luth-001';
const info = { ipAddress: '127.0.0.1', userAgent: 'test' };
const doctor = rt.seedData.clinicians.find((c) => c.facilityId === FACILITY && c.status === 'VERIFIED')!;
const doctorActor = { userId: doctor.userId, role: 'DOCTOR' as const, clinicianId: doctor.id, facilityId: FACILITY, isVerifiedClinician: true };
const platform = rt.accounts.get('admin-platform-demo')!;
let doctorToken = '';
let facilityAdminToken = '';

function consentFor(patientId: string) {
  const r = rt.consentManager.createAccessRequest({ patientId, clinicianId: doctor.id, clinicianName: doctor.fullName, facilityId: FACILITY, facilityName: 'LUTH', requestedScopes: ['all'], durationPreset: 'SEVEN_DAYS', clinicalReason: 'Synthetic care' });
  rt.consentManager.approveInApp(r.requestId, patientId);
  return rt.consentManager.resolveActiveConsent(patientId, doctor.id, FACILITY)!;
}
async function registerWithNin(first: string, last: string, dob: string, nin: string) {
  // The synthetic demo register knows these numbers; registration verifies against it.
  return rt.registration.register(platform, { facilityId: FACILITY, firstName: first, lastName: last, dateOfBirth: dob, gender: 'male', identifiers: [{ country: 'NG', idType: 'NIN', idNumber: nin }] }, info);
}
const signCondition = (patientId: string, text: string) =>
  rt.clinicalStore.writeRecord(patientId, { resourceType: 'Condition', id: '', code: { text }, subject: { reference: `Patient/${patientId}` }, recordedDate: new Date().toISOString() } as any, doctorActor, { consent: consentFor(patientId), facilityId: FACILITY });

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  doctorToken = (await call('POST', '/api/clinician/login', { clinicianId: doctor.id, totp: generateTotp(rt.staff.demoTotpSecret(doctor.id)!) })).body.token;
  const fa = `admin-${FACILITY}-demo`;
  facilityAdminToken = (await call('POST', '/api/admin/login', { adminId: fa, totp: generateTotp(rt.staff.demoTotpSecret(fa)!) })).body.token;
});
after(() => { server.close(); });

describe('Outbound national exchange (outbox)', () => {
  test('A signed record with national-exchange consent is queued and pushed; without consent nothing is pushed', async () => {
    const shared = await registerWithNin('Babatunde', 'Olatunji', '1985-11-02', '90000000002');
    const notShared = rt.seedData.patients[0].patient;
    const on = await call('POST', `/api/patients/${shared.patientId}/national-exchange`, { enabled: true });
    assert.deepStrictEqual([on.status, on.body.enabled], [200, true]);
    assert.ok(rt.consentManager.getPatientConsents(shared.patientId).some((g) => g.scopes.includes('national-exchange')));
    assert.strictEqual(rt.consentManager.resolveActiveConsent(shared.patientId, 'anyone', 'any-facility'), null, 'the exchange consent opens nothing inside Medistry');

    const { record } = signCondition(shared.patientId, 'Synthetic shared diagnosis');
    signCondition(notShared.id, 'Synthetic private diagnosis');
    const queued = rt.nationalExchange.all().filter((m) => m.status === 'PENDING');
    assert.deepStrictEqual(queued.map((m) => [m.patientId, m.recordId, m.connector]), [[shared.patientId, record.id, 'NG']], 'only the consenting patient\'s record is queued');

    await rt.nationalExchange.processDue();
    assert.strictEqual(exchange.pushes.length, 1);
    const pushed = exchange.pushes[0];
    assert.deepStrictEqual(pushed.subject, { identifier: { system: 'urn:test:exchange:nin', value: '90000000002' } }, 'subject by national identifier, not a Medistry id');
    assert.strictEqual(pushed.id, undefined);
    assert.ok(!JSON.stringify(pushed).includes('Synthetic private diagnosis'));
    assert.deepStrictEqual(pushed.identifier.at(-1), { system: 'urn:medistry:record-id', value: record.id });
    const sent = rt.nationalExchange.all().find((m) => m.recordId === record.id)!;
    assert.deepStrictEqual([sent.status, sent.attempts, sent.remoteId], ['SENT', 1, 'remote-1']);
    assert.ok(rt.auditManager.getEntries().some((e) => e.action === 'NATIONAL_EXCHANGE_PUSHED' && e.resourceId === record.id));
    assert.ok(!rt.auditManager.getEntries().some((e) => e.action.startsWith('NATIONAL_EXCHANGE') && e.subjectId === notShared.id), 'nothing for the patient without consent');

    // Withdrawn consent before sending cancels the message.
    const r2 = signCondition(shared.patientId, 'Synthetic second diagnosis').record;
    await call('POST', `/api/patients/${shared.patientId}/national-exchange`, { enabled: false });
    await rt.nationalExchange.processDue();
    assert.strictEqual(rt.nationalExchange.all().find((m) => m.recordId === r2.id)!.status, 'CANCELLED');
    assert.strictEqual(exchange.pushes.length, 1);
  });

  test('A failed push retries with backoff, then dead-letters, and the admin view shows it', async () => {
    const p = await registerWithNin('Hauwa', 'Ɗanjuma', '2001-07-21', '90000000003');
    rt.consentManager.grantNationalExchange(p.patientId, 'NG exchange');
    exchange.mode = 'transient';
    const { record } = signCondition(p.patientId, 'Synthetic failing push');
    let now = Date.now();
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++) {
      await rt.nationalExchange.processDue(now);
      now += OUTBOX_RETRY_BASE_MS * 2 ** i + 1;
    }
    const m = rt.nationalExchange.all().find((x) => x.recordId === record.id)!;
    assert.deepStrictEqual([m.status, m.attempts, m.lastError], ['DEAD', OUTBOX_MAX_ATTEMPTS, 'HTTP 503']);
    const failures = rt.auditManager.getEntries().filter((e) => e.resourceId === record.id && e.action === 'NATIONAL_EXCHANGE_PUSH_FAILED');
    assert.strictEqual(failures.length, OUTBOX_MAX_ATTEMPTS - 1, 'each retry audited');
    assert.ok(rt.auditManager.getEntries().some((e) => e.resourceId === record.id && e.action === 'NATIONAL_EXCHANGE_DEAD_LETTER'));

    const view = await call('GET', '/api/admin/integrations', undefined, facilityAdminToken);
    assert.strictEqual(view.status, 200, JSON.stringify(view.body));
    assert.ok(view.body.outbox.failed >= 1 && view.body.outbox.sent >= 1);
    assert.ok(view.body.lastSyncAt);
    const dl = view.body.deadLetters.find((d: any) => d.recordId === record.id);
    assert.deepStrictEqual([dl.attempts, dl.lastError, dl.connector], [OUTBOX_MAX_ATTEMPTS, 'HTTP 503', 'NG']);
    assert.ok(view.body.connectors.some((c: any) => c.name === 'mock-exchange' && c.configured));
    assert.ok(!JSON.stringify(view.body).includes('Synthetic failing push'), 'no clinical content in the admin view');

    // An admin requeues it once the exchange recovers.
    exchange.mode = 'ok';
    assert.strictEqual((await call('POST', `/api/admin/integrations/outbox/${m.id}/retry`, {}, facilityAdminToken)).body.status, 'PENDING');
    await rt.nationalExchange.processDue();
    assert.strictEqual(m.status, 'SENT');

    // A permanent refusal (4xx) dead-letters at once.
    exchange.mode = 'permanent';
    const r3 = signCondition(p.patientId, 'Synthetic refused push').record;
    await rt.nationalExchange.processDue();
    const m3 = rt.nationalExchange.all().find((x) => x.recordId === r3.id)!;
    assert.deepStrictEqual([m3.status, m3.attempts], ['DEAD', 1]);
    exchange.mode = 'ok';
  });
});

describe('Inbound national exchange summary', () => {
  test('Only with consent or an active break-glass grant; shown with its source, never merged', async () => {
    const p = await registerWithNin('Adaeze', 'Nwosu', '1990-03-14', '90000000001');
    assert.strictEqual((await call('GET', `/api/clinician/patients/${p.patientId}/national-summary`, undefined, doctorToken)).status, 403, 'no consent');
    assert.strictEqual(exchange.queries, 0);
    consentFor(p.patientId);
    const before = rt.clinicalStore.getLatestFinalRecords(p.patientId, 'Condition').length;
    const s = await call('GET', `/api/clinician/patients/${p.patientId}/national-summary`, undefined, doctorToken);
    assert.strictEqual(s.status, 200, JSON.stringify(s.body));
    assert.deepStrictEqual([s.body.source, s.body.mergedIntoRecord, s.body.resources.length], ['National exchange (NG)', false, 1]);
    assert.strictEqual(rt.clinicalStore.getLatestFinalRecords(p.patientId, 'Condition').length, before, 'nothing written into the Medistry record');
    const bg = await call('POST', '/api/emergency/break-glass', { code: rt.codeByPatient.get(p.patientId)!.formattedCode, reason: 'UNCONSCIOUS' }, doctorToken);
    const em = await call('GET', `/api/emergency/grants/${bg.body.grantId}/national-summary`, undefined, doctorToken);
    assert.deepStrictEqual([em.status, em.body.source], [200, 'National exchange (NG)']);
    const audits = rt.auditManager.getEntries().filter((e) => e.action === 'NATIONAL_EXCHANGE_QUERIED' && e.subjectId === p.patientId);
    assert.deepStrictEqual(audits.map((e) => e.accessType), ['NORMAL_CONSENT', 'EMERGENCY_BREAK_GLASS']);
  });

  test('The country connectors are config-driven FHIR R4 clients (HTTPS only, no invented endpoints)', async () => {
    assert.strictEqual(new KenyaShrConnector(hieConfigFromEnv('HIE_KE_', {})).getStatus().configured, false);
    await assert.rejects(new NigeriaHieConnector(hieConfigFromEnv('HIE_NG_', {})).pushRecord({ resourceType: 'Condition' }), HieNotConfigured);
    assert.strictEqual(hieConfigFromEnv('HIE_KE_', { HIE_KE_BASE_URL: 'http://insecure.test' }).baseUrl, undefined, 'HTTP base URLs are refused');
    const calls: string[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url} ${(init.headers as any).Authorization || ''}`);
      if (String(url).includes('/Patient?identifier=')) return new Response(JSON.stringify({ resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Patient', id: 'ex-1' } }] }), { status: 200 });
      if (String(url).endsWith('/$everything')) return new Response(JSON.stringify({ resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Observation' } }] }), { status: 200 });
      if (String(url).endsWith('/Fail')) return new Response('{}', { status: 503 });
      return new Response(JSON.stringify({ id: 'created-1' }), { status: 201 });
    }) as unknown as typeof fetch;
    const c = new FhirHieConnector('sandbox', 'KE', hieConfigFromEnv('HIE_KE_', { HIE_KE_BASE_URL: 'https://shr.sandbox.test/fhir', HIE_KE_ACCESS_TOKEN: 'tok', HIE_KE_ID_SYSTEM_NATIONAL_ID: 'urn:test:ke-id' }), { fetch: fakeFetch });
    assert.deepStrictEqual(await c.pushRecord({ resourceType: 'Condition' }), { remoteId: 'created-1' });
    const s = await c.queryPatientSummary({ country: 'KE', idType: 'NATIONAL_ID', idNumber: '90000001', medistryPatientId: 'x' });
    assert.strictEqual(s.resources.length, 1);
    assert.deepStrictEqual(calls, [
      'POST https://shr.sandbox.test/fhir/Condition Bearer tok',
      `GET https://shr.sandbox.test/fhir/Patient?identifier=${encodeURIComponent('urn:test:ke-id|90000001')} Bearer tok`,
      'GET https://shr.sandbox.test/fhir/Patient/ex-1/$everything Bearer tok',
    ]);
    await assert.rejects(c.pushRecord({ resourceType: 'Fail' }), HieTransientError);
    assert.strictEqual(c.getStatus().lastError, 'HTTP 503');
  });
});

describe('Pharmacies', () => {
  let pharmacyId = '';
  let pharmacistToken = '';
  const patient = rt.seedData.patients[0].patient;

  before(async () => {
    const f = await call('POST', '/api/admin/facilities', { name: 'Synthetic Community Pharmacy', kind: 'PHARMACY', countryCode: 'NG', region: 'Lagos' }, (await call('POST', '/api/admin/login', { adminId: 'admin-platform-demo', totp: generateTotp(rt.staff.demoTotpSecret('admin-platform-demo')!) })).body.token);
    assert.strictEqual(f.status, 200, JSON.stringify(f.body));
    pharmacyId = f.body.facility.id;
    const created = await rt.staff.createRecordsOfficer(platform, { facilityId: pharmacyId, name: 'Synthetic Pharmacist', email: 'pharmacist@example.org', password: 'synthetic-pharm-pass' }, info, 'PHARMACIST');
    const totp = generateTotp(generateTotpSecret(20, fromRfc4648Base32(new URL(created.totpEnrolment.otpauthUri).searchParams.get('secret')!)));
    const login = await call('POST', '/api/admin/login', { email: 'pharmacist@example.org', password: 'synthetic-pharm-pass', totp });
    assert.strictEqual(login.status, 200, JSON.stringify(login.body));
    pharmacistToken = login.body.token;
  });

  test('A pharmacy reads active medications with consent (OTP to the patient), not without it', async () => {
    assert.strictEqual((await call('GET', `/api/pharmacy/patients/${patient.id}/medications`, undefined, pharmacistToken)).status, 403, 'no consent');
    const req = await call('POST', '/api/pharmacy/access/request', { emergencyCode: rt.codeByPatient.get(patient.id)!.formattedCode }, pharmacistToken);
    assert.strictEqual(req.status, 200, JSON.stringify(req.body));
    assert.ok(!('otp' in req.body) && !JSON.stringify(req.body).match(/\b\d{6}\b/), 'the pharmacist never receives the code');
    const otp = rt.consoleProvider.sentPushLogs.filter((x) => x.toUserId === patient.id && x.title === 'Pharmacy access request').at(-1)!.body.match(/Code: (\d{6})/)![1];
    assert.strictEqual((await call('POST', `/api/pharmacy/access/${req.body.requestId}/otp`, { otp: '000000' }, pharmacistToken)).status, 403);
    const ok = await call('POST', `/api/pharmacy/access/${req.body.requestId}/otp`, { otp }, pharmacistToken);
    assert.deepStrictEqual([ok.status, ok.body.patientId], [200, patient.id]);
    const meds = await call('GET', `/api/pharmacy/patients/${patient.id}/medications`, undefined, pharmacistToken);
    assert.strictEqual(meds.status, 200);
    assert.deepStrictEqual(meds.body.medications.map((m: any) => m.name).sort(), patient.activeMedications.map((m) => m.medicationName).sort());
    assert.ok(!JSON.stringify(meds.body).match(/allerg|condition|diagnos/i), 'medications only');
    const grant = rt.consentManager.getPatientConsents(patient.id).find((g) => g.targetFacilityId === pharmacyId)!;
    assert.deepStrictEqual(grant.scopes, ['MedicationStatement', 'MedicationDispense']);
    assert.strictEqual((await call('GET', `/api/clinician/patients/${patient.id}/record`, undefined, pharmacistToken)).status, 403, 'no clinical record access');
  });

  test('A pharmacy records dispensing but can never edit a prescription', async () => {
    const meds = (await call('GET', `/api/pharmacy/patients/${patient.id}/medications`, undefined, pharmacistToken)).body.medications;
    const statementId = meds[0].medicationStatementId;
    const before = rt.clinicalStore.getRecordById(statementId)!;
    const d = await call('POST', `/api/pharmacy/patients/${patient.id}/dispense`, { medicationStatementId: statementId, quantity: 30, unit: 'tablet' }, pharmacistToken);
    assert.strictEqual(d.status, 200, JSON.stringify(d.body));
    const dispense = rt.clinicalStore.getRecordById(d.body.dispenseId)!;
    assert.deepStrictEqual([dispense.resourceType, dispense.source, dispense.originFacilityId, dispense.status], ['MedicationDispense', 'pharmacy', pharmacyId, 'final']);
    const after = rt.clinicalStore.getRecordById(statementId)!;
    assert.deepStrictEqual([after.isLatest, after.versionId, after.payloadSignature], [true, before.versionId, before.payloadSignature], 'the prescription is unchanged');

    // No route edits a prescription, and the policy engine refuses it even if code tried.
    assert.strictEqual((await call('POST', `/api/pharmacy/patients/${patient.id}/medications/${statementId}`, { status: 'stopped' }, pharmacistToken)).status, 404);
    const pharmacistActor = { userId: 'p', role: 'PHARMACIST' as const, clinicianId: 'p', facilityId: pharmacyId };
    for (const action of ['PATIENT_WRITE_RECORD', 'PATIENT_DRAFT_RECORD', 'PATIENT_READ_RECORD', 'EMERGENCY_BREAK_GLASS'] as const) {
      assert.strictEqual(evaluatePolicy({ actor: pharmacistActor, action, targetPatientId: patient.id }).allowed, false, action);
    }
    const consent = rt.consentManager.getPatientConsents(patient.id).find((g) => g.targetFacilityId === pharmacyId)!;
    assert.throws(() => rt.clinicalStore.updateRecord(statementId, { ...(JSON.parse('{}')), resourceType: 'MedicationStatement', status: 'stopped' } as any, pharmacistActor as any, { consent, facilityId: pharmacyId, reason: 'x' }), /Forbidden/);
  });

  test("Card scan in online mode grants access only for the patient's current card; pharmacies cannot import", async () => {
    const other = rt.seedData.patients[1].patient;
    const issued = rt.offlineCardStore.issue(other);
    const ok = await call('POST', '/api/pharmacy/access/card', { token: `https://medistry.example/s#${issued.token}` }, pharmacistToken);
    assert.deepStrictEqual([ok.status, ok.body.patientId], [200, other.id]);
    assert.ok(rt.auditManager.getEntries().some((e) => e.action === 'PHARMACY_ACCESS_BY_CARD' && e.subjectId === other.id));
    rt.offlineCardStore.revoke(other.id, issued.card.version, 'lost');
    assert.strictEqual((await call('POST', '/api/pharmacy/access/card', { token: issued.token }, pharmacistToken)).status, 403, 'a revoked card does not work');
    assert.strictEqual((await call('POST', '/api/pharmacy/access/card', { token: 'not.a.card' }, pharmacistToken)).status, 403);

    const { client } = await rt.apiClients.create(platform, { name: 'Synthetic pharmacy POS', facilityId: pharmacyId }, info);
    const res = await rt.fhirImport.importBundle({ resourceType: 'Bundle', type: 'collection', entry: [{ resource: { resourceType: 'Condition', id: 'x', code: { text: 'x' }, subject: { reference: `Patient/${patient.id}` } } }] }, { id: client.id, clientId: client.clientId, facilityId: pharmacyId }, info).catch((e) => e);
    assert.strictEqual(res.status, 403);
    assert.match(res.outcome.issue[0].diagnostics, /Pharmacies cannot import/);
  });
});

describe('Laboratories', () => {
  test('A lab result links to the ordering clinician and notifies the patient with no clinical content', async () => {
    const lab = { id: 'fac-lab-synthetic', name: 'Synthetic Reference Laboratory', kind: 'LAB' as const, countryCode: 'NG', region: 'Lagos', type: 'Laboratory', address: 'Synthetic', registryCode: null };
    rt.addFacility(lab);
    const { client, clientSecret } = await rt.apiClients.create(platform, { name: 'Synthetic LIS', facilityId: lab.id }, info);
    const tok = await fetch(`${base}/api/fhir/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: client.clientId, client_secret: clientSecret }) });
    const token = ((await tok.json()) as any).access_token;
    const patient = rt.seedData.patients[2].patient;
    rt.patientAuth.linkPatient(patient, '+2348000000917', { ...info, adminId: platform.id });
    consentFor(patient.id); // the ordering clinician's consent connects the lab to this patient

    const bundle = (withOrder: boolean, extra: any[] = []) => ({ resourceType: 'Bundle', type: 'collection', entry: [
      { fullUrl: 'urn:uuid:order', resource: { resourceType: 'ServiceRequest', id: 'order-1', requester: { reference: `Practitioner/${doctor.id}` } } },
      { resource: { resourceType: 'DiagnosticReport', identifier: [{ system: 'urn:synthetic:lis', value: `R-${withOrder}` }], status: 'final', code: { text: 'Synthetic full blood count' }, subject: { reference: `Patient/${patient.id}` }, conclusion: 'Synthetic haemoglobin 9.1 g/dL', ...(withOrder ? { basedOn: [{ reference: 'urn:uuid:order' }] } : {}) } },
      { resource: { resourceType: 'Observation', identifier: [{ system: 'urn:synthetic:lis', value: `O-${withOrder}` }], status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '718-7', display: 'Hemoglobin' }] }, subject: { reference: `Patient/${patient.id}` }, valueQuantity: { value: 9.1, unit: 'g/dL' }, ...(withOrder ? { basedOn: [{ reference: 'ServiceRequest/order-1' }] } : {}) } },
      ...extra,
    ] });
    const noOrder = await call('POST', '/api/fhir/import', bundle(false), token);
    assert.strictEqual(noOrder.status, 422);
    assert.match(noOrder.body.issue[0].diagnostics, /must reference its order/);
    const notLabType = await call('POST', '/api/fhir/import', bundle(true, [{ resource: { resourceType: 'Condition', id: 'c', code: { text: 'x' }, subject: { reference: `Patient/${patient.id}` } } }]), token);
    assert.match(notLabType.body.issue.map((i: any) => i.diagnostics).join(' '), /Laboratories submit DiagnosticReport and Observation only/);

    const smsBefore = rt.consoleProvider.sentSmsLogs.length;
    const r = await call('POST', '/api/fhir/import', bundle(true), token);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const reports = rt.clinicalStore.getLatestFinalRecords(patient.id, 'DiagnosticReport').filter(({ record }) => record.originFacilityId === lab.id);
    assert.strictEqual(reports.length, 1);
    assert.deepStrictEqual([reports[0].record.status, reports[0].record.orderingClinicianId], ['final', doctor.id], 'final lab result linked to the ordering clinician');
    const results = await call('GET', '/api/clinician/lab-results', undefined, doctorToken);
    assert.ok(results.body.results.some((x: any) => x.patientId === patient.id && x.title === 'Synthetic full blood count'), 'in the ordering clinician\'s results list');

    const sms = rt.consoleProvider.sentSmsLogs.slice(smsBefore).filter((s) => s.to === '+2348000000917');
    assert.strictEqual(sms.length, 1, 'one SMS per bundle');
    assert.strictEqual(sms[0].message, renderSms('lab_result_ready', patient.preferredLocale));
    for (const leak of ['blood count', 'haemoglobin', 'Hemoglobin', '9.1', 'g/dL', 'Synthetic']) assert.ok(!sms[0].message.includes(leak), `no "${leak}" in the SMS`);
    for (const locale of SUPPORTED_LOCALES) assert.ok(!/\d/.test(renderSms('lab_result_ready', locale)), `${locale}: no values in the template`);
    const push = rt.consoleProvider.sentPushLogs.filter((x) => x.toUserId === patient.id && x.title === 'Result ready').at(-1)!;
    assert.ok(!/blood|haemoglobin|9\.1/i.test(push.body));
    assert.ok(rt.consoleProvider.sentPushLogs.some((x) => x.toUserId === doctor.userId && x.title === 'Lab result ready'));
    assert.ok(rt.auditManager.getEntries().some((e) => e.action === 'LAB_RESULT_NOTIFIED' && e.subjectId === patient.id && !/blood|9\.1/i.test(e.reason || '')));
  });
});
