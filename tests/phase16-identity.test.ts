// Phase 16: one person, one record. National identifiers with a blind index, probabilistic duplicate detection
// with a human review queue (never auto-merge), merge and unmerge, name normalisation, and identity verification
// that never blocks emergency care. Synthetic people and synthetic ID numbers only.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createRuntime } from '../src/lib/runtime.ts';
import { createMemoryPersistence } from '../src/lib/data/memory/persistence.ts';
import { createPortalApi } from '../src/lib/site/portalApi.ts';
import { generateTotp } from '../src/lib/auth/security.ts';
import { nameTokens, nameSimilarity, foldName } from '../src/lib/identity/names.ts';
import { scoreMatch, REVIEW_THRESHOLD } from '../src/lib/identity/mpi.ts';
import { identityBlindIndex } from '../src/lib/identity/identityStore.ts';
import { NimcVerifier, KenyaIdVerifier, FakeIdentityVerifier, createIdentityVerifier } from '../src/lib/identity/IdentityVerifier.ts';
import { PatientRegistrationService } from '../src/lib/identity/registration.ts';
import type { Persistence } from '../src/lib/data/repositories.ts';

// Every write the app makes, serialised, plus every log line: the raw NIN must appear in neither.
const written: string[] = [];
const memory = createMemoryPersistence();
const recording = new Proxy(memory, {
  get(target, prop: string) {
    const v = (target as any)[prop];
    if (typeof v === 'function' && prop.startsWith('save') || prop === 'appendAudit') return (...args: unknown[]) => { written.push(JSON.stringify(args)); return v.apply(target, args); };
    return v;
  },
}) as Persistence;
const logged: string[] = [];
for (const m of ['log', 'warn', 'error'] as const) {
  const orig = console[m].bind(console);
  console[m] = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); orig(...args); };
}

const rt = await createRuntime(recording);
const api = createPortalApi({ ...rt, notifications: rt.consoleProvider, offlineCards: rt.offlineCardStore, dataDir: path.join(os.tmpdir(), 'medistry-phase16') });
let base = '';
const server = http.createServer(async (req, res) => {
  if (!(await api(req, res, new URL(req.url || '/', 'http://localhost')))) { res.writeHead(404); res.end('{}'); }
});
const responses: string[] = [];
async function call(method: string, p: string, body?: unknown, token?: string) {
  const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  responses.push(text);
  return { status: r.status, body: JSON.parse(text || '{}') as any };
}

const FACILITY = 'fac-luth-001';
const OTHER_FACILITY = 'fac-kano-001';
const info = { ipAddress: '127.0.0.1', userAgent: 'test' };
const NIN = '90000000002'; // synthetic register: "Babatunde Olatunji", 1985-11-02
let officer = '';
let otherOfficer = '';
let doctorToken = '';
const doctor = rt.seedData.clinicians.find((c) => c.facilityId === FACILITY && c.status === 'VERIFIED')!;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = async (adminId: string) => (await call('POST', '/api/admin/login', { adminId, totp: generateTotp(rt.staff.demoTotpSecret(adminId)!) })).body.token;
  officer = await login(`records-${FACILITY}-demo`);
  otherOfficer = await login(`records-${OTHER_FACILITY}-demo`);
  doctorToken = (await call('POST', '/api/clinician/login', { clinicianId: doctor.id, totp: generateTotp(rt.staff.demoTotpSecret(doctor.id)!) })).body.token;
  assert.ok(officer && otherOfficer && doctorToken);
});
after(() => { server.close(); });

describe('Name normalisation (West and East African naming patterns)', () => {
  const sim = (a: string, b: string) => nameSimilarity(nameTokens(a), nameTokens(b));
  test('Same person written differently scores high', () => {
    const same: Array<[string, string, string]> = [
      ['Amara Okonkwo', 'Okonkwo Amara', 'family name first'],
      ['Chukwuemeka Obinna Eze', 'Obinna Eze', 'one of several given names in use'],
      ['Grace Achieng Odhiambo', 'Odhiambo Grace Achieng', 'reordered middle names'],
      ['Tunde Adebayo-Johnson', 'Adebayo Johnson Tunde', 'hyphenated compound'],
      ['Ọlágúnjú Adébáyọ̀', 'Olagunju Adebayo', 'Yoruba tone marks and under-dots'],
      ['Musa Ɗanjuma', 'Musa Danjuma', 'Hausa hooked letter'],
      ['Alhaji Musa Bello', 'Musa Bello', 'honorific in the name field'],
      ['Wanjiku wa Kamau', 'Kamau Wanjiku', 'connective particle'],
      ['Fatima binti Hassan', 'Hassan Fatima', 'connective particle (Swahili)'],
      ['Oluwaseun Ade', 'Oluwa Seun Ade', 'compound written apart'],
      ['Mohammed Bello', 'Muhammad Bello', 'common transliteration variant'],
      ['ADAEZE  nwosu', 'Adaeze Nwosu', 'case and spacing'],
    ];
    for (const [a, b, why] of same) assert.ok(sim(a, b) >= 0.85, `${why}: "${a}" vs "${b}" scored ${sim(a, b).toFixed(2)}`);
  });

  test('Different people score low, even with a shared family name', () => {
    const different: Array<[string, string, string]> = [
      ['Amara Okonkwo', 'Ngozi Okonkwo', 'siblings'],
      ['John Otieno', 'Jane Otieno', 'similar given names, same family'],
      ['Amara Okonkwo', 'Fatima Bello', 'unrelated'],
      ['Kamau Njoroge', 'Wanjiru Muthoni', 'unrelated (Kenya)'],
    ];
    for (const [a, b, why] of different) assert.ok(sim(a, b) < 0.6, `${why}: "${a}" vs "${b}" scored ${sim(a, b).toFixed(2)}`);
  });

  test('Words that are titles in some places but common names elsewhere are kept', () => {
    assert.deepStrictEqual(nameTokens('Chief Eze Okafor'), ['eze', 'okafor'], '"Chief" dropped, the surname Eze kept');
    assert.deepStrictEqual(nameTokens('Dr. Sheikh Abdullahi'), ['sheikh', 'abdullahi']);
    assert.strictEqual(foldName('Ọ̀ṣun Ẹ̀kọ́'), 'osun eko');
  });

  test('Match scoring: day/month swapped dates count partly; a different phone counts against', () => {
    const a = { name: 'Amara Okonkwo', dob: '1998-04-12', gender: 'female', phone: '+2348000000001' };
    assert.strictEqual(scoreMatch(a, { ...a, name: 'Okonkwo Amara' }).score, 1);
    assert.ok(scoreMatch(a, { ...a, dob: '1998-12-04' }).breakdown.dob === 0.7);
    assert.ok(scoreMatch(a, { ...a, phone: '+2348000000009' }).score < scoreMatch(a, { ...a, phone: undefined }).score);
  });
});

describe('National identifiers: blind index', () => {
  let patientId = '';

  test('Exact match by blind index finds the same patient; the raw NIN never appears in storage, logs, audit or responses', async () => {
    const r = await call('POST', '/api/admin/patients', { firstName: 'Babatunde', lastName: 'Olatunji', dateOfBirth: '1985-11-02', gender: 'male', identifiers: [{ country: 'NG', idType: 'NIN', idNumber: NIN }] }, officer);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.outcome, 'created');
    assert.deepStrictEqual(r.body.identity, [{ country: 'NG', idType: 'NIN', display: 'NIN ••••••02', status: 'verified', verifier: 'synthetic-demo-register' }]);
    patientId = r.body.patientId;
    assert.strictEqual(rt.identity.findPatient('NG', 'NIN', NIN), patientId);
    assert.strictEqual(rt.identity.findPatient('NG', 'NIN', '900-0000-0002'), patientId, 'formatting does not matter');

    // The same NIN again (name spelt differently): the existing record, no new patient.
    const count = rt.patientsById.size;
    const again = await call('POST', '/api/admin/patients', { firstName: 'Tunde', lastName: 'Olatunji', dateOfBirth: '1985-11-02', gender: 'male', identifiers: [{ country: 'NG', idType: 'NIN', idNumber: NIN }] }, officer);
    assert.deepStrictEqual([again.body.outcome, again.body.patientId], ['existing', patientId]);
    assert.strictEqual(rt.patientsById.size, count);

    // FHIR import matches the Patient by the national identifier (blind index), including a configured alias system.
    const admin = rt.accounts.get(`admin-${FACILITY}-demo`)!;
    const { client } = await rt.apiClients.create(admin, { name: 'Synthetic EMR' }, info);
    process.env.IDENTITY_FHIR_SYSTEMS = 'https://ids.synthetic.example/nin=NG:NIN';
    try {
      for (const system of ['urn:medistry:id:NG:NIN', 'https://ids.synthetic.example/nin']) {
        const res = await rt.fhirImport.importBundle({ resourceType: 'Bundle', type: 'collection', entry: [
          { fullUrl: 'urn:uuid:p', resource: { resourceType: 'Patient', identifier: [{ system, value: NIN }], birthDate: '1985-11-02' } },
          { resource: { resourceType: 'Observation', identifier: [{ system: 'urn:synthetic:obs', value: system }], status: 'final', code: { text: 'Synthetic weight' }, subject: { reference: 'urn:uuid:p' } } },
        ] }, { id: client.id, clientId: client.clientId, facilityId: FACILITY }, info);
        assert.strictEqual(res.summary.created, 1, system);
      }
    } finally {
      delete process.env.IDENTITY_FHIR_SYSTEMS;
    }

    // The blind index uses its own key: not the field key, and not reversible without it.
    const other = identityBlindIndex('NG', 'NIN', NIN, { IDENTITY_INDEX_KEY: crypto.randomBytes(32).toString('hex') });
    assert.notStrictEqual(other, identityBlindIndex('NG', 'NIN', NIN));
    assert.match(identityBlindIndex('NG', 'NIN', NIN), /^[0-9a-f]{64}$/);

    const everywhere = [...written, ...logged, JSON.stringify(rt.auditManager.getEntries()), ...responses].join('\n');
    assert.ok(!everywhere.includes(NIN), 'raw NIN found in storage, logs, audit or a response');
    assert.ok(written.some((w) => w.includes('"blindIndex"')), 'the identifier was stored (encrypted + blind index)');
  });

  test('A mismatch or unknown number stops registration (demo register); format errors never echo the number', async () => {
    const mismatch = await call('POST', '/api/admin/patients', { firstName: 'Someone', lastName: 'Else', dateOfBirth: '1990-03-14', gender: 'female', identifiers: [{ country: 'NG', idType: 'NIN', idNumber: '90000000001' }] }, officer);
    assert.deepStrictEqual([mismatch.status, /do not match the national record/.test(mismatch.body.error)], [422, true]);
    const unknown = await call('POST', '/api/admin/patients', { firstName: 'Synthetic', lastName: 'Unknown', dateOfBirth: '1990-01-01', gender: 'male', identifiers: [{ country: 'NG', idType: 'NIN', idNumber: '91234567890' }] }, officer);
    assert.deepStrictEqual([unknown.status, /not found/.test(unknown.body.error)], [422, true]);
    const bad = await call('POST', '/api/admin/patients', { firstName: 'Synthetic', lastName: 'Bad', dateOfBirth: '1990-01-01', gender: 'male', identifiers: [{ country: 'NG', idType: 'NIN', idNumber: '12345' }] }, officer);
    assert.strictEqual(bad.status, 400);
    assert.ok(!bad.body.error.includes('12345'));
  });
});

describe('Probable duplicates: review queue, never auto-merged', () => {
  test('A swapped name order with the same date of birth and phone is flagged as a candidate and NOT merged', async () => {
    const a = await call('POST', '/api/admin/patients', { firstName: 'Achieng', otherNames: 'Grace', lastName: 'Odhiambo', dateOfBirth: '1993-05-09', gender: 'female', phone: '+254700000123' }, officer);
    assert.strictEqual(a.body.outcome, 'created');
    assert.strictEqual(a.body.phoneLinked, true);
    const b = await call('POST', '/api/admin/patients', { firstName: 'Odhiambo', lastName: 'Achieng', dateOfBirth: '1993-05-09', gender: 'female', phone: '+254700000123' }, officer);
    assert.strictEqual(b.status, 200, JSON.stringify(b.body));
    assert.strictEqual(b.body.outcome, 'created', 'a new record: probable duplicates are never merged automatically');
    assert.strictEqual(b.body.phoneLinked, false, 'the phone stays with the existing record');
    assert.strictEqual(b.body.duplicateCandidates.length, 1);
    const [cand] = b.body.duplicateCandidates;
    assert.strictEqual(cand.candidatePatientId, a.body.patientId);
    assert.ok(cand.score >= REVIEW_THRESHOLD);
    assert.strictEqual(rt.patientsById.get(b.body.patientId)!.mergedIntoPatientId, undefined, 'not merged');
    assert.deepStrictEqual(rt.mpi.linkedIds(a.body.patientId), []);
    const queue = await call('GET', '/api/admin/mpi/reviews', undefined, officer);
    const review = queue.body.reviews.find((r: any) => r.id === cand.reviewId);
    assert.strictEqual(review.status, 'OPEN');
    assert.deepStrictEqual([review.patient.name, review.candidate.name], ['Odhiambo Achieng', 'Achieng Grace Odhiambo']);
    assert.match(review.candidate.phone, /^\+254•••123$/, 'phone masked in the queue');
    assert.ok(rt.auditManager.getEntries().some((e) => e.action === 'MPI_DUPLICATE_QUEUED' && e.subjectId === b.body.patientId));

    // A different person with the same family name is not queued.
    const c = await call('POST', '/api/admin/patients', { firstName: 'Kevin', lastName: 'Odhiambo', dateOfBirth: '1970-01-20', gender: 'male' }, officer);
    assert.deepStrictEqual(c.body.duplicateCandidates, []);
  });

  test('Merge then unmerge restores the original state; both are audited', async () => {
    const queue = (await call('GET', '/api/admin/mpi/reviews', undefined, officer)).body.reviews;
    const review = queue.find((r: any) => r.patient.name === 'Odhiambo Achieng');
    const survivorId = review.candidatePatientId;
    const dupId = review.patientId;
    const survivor = rt.patientsById.get(survivorId)!;
    const dup = rt.patientsById.get(dupId)!;
    // The duplicate has its own history and safety data.
    dup.allergies.push({ substance: 'Synthetic cotrimoxazole', category: 'drug', reaction: 'Rash', severity: 'severe' });
    rt.clinicalStore.importRecord(dupId, { resourceType: 'Condition', id: '', code: { text: 'Synthetic asthma' }, subject: { reference: `Patient/${dupId}` } } as any,
      { facilityId: FACILITY, externalKey: crypto.randomUUID(), authorClinicianId: doctor.id, clientId: 'test' });
    const snapshot = () => JSON.stringify({
      survivor: rt.patientsById.get(survivorId), dup: rt.patientsById.get(dupId),
      survivorRecords: rt.clinicalStore.getLatestFinalRecords(survivorId, 'Condition').map((r) => r.record.id),
      dupRecords: rt.clinicalStore.getLatestFinalRecords(dupId, 'Condition').map((r) => r.record.id),
      review: rt.mpi.listReviews(rt.accounts.get('admin-platform-demo')!, 'OPEN', info).find((r) => r.id === review.id)?.status,
    });
    const before = snapshot();

    assert.strictEqual((await call('POST', `/api/admin/mpi/reviews/${review.id}/merge`, {}, otherOfficer)).status, 403, 'another facility\'s records officer cannot merge');
    const merged = await call('POST', `/api/admin/mpi/reviews/${review.id}/merge`, {}, officer);
    assert.strictEqual(merged.status, 200, JSON.stringify(merged.body));
    const mergeId = merged.body.merge.id;
    assert.deepStrictEqual([merged.body.merge.survivorId, merged.body.merge.mergedId], [survivorId, dupId]);
    // While merged: one person, both histories.
    assert.ok(rt.clinicalStore.getLatestFinalRecords(survivorId, 'Condition').some(({ resource }) => (resource as any).code.text === 'Synthetic asthma'), 'survivor shows the merged history');
    assert.strictEqual(rt.clinicalStore.getLatestFinalRecords(dupId, 'Condition').length, 1, 'the merged record keeps its own history');
    const dupCode = rt.codeByPatient.get(dupId)!.formattedCode;
    const gate = await call('GET', `/api/emergency/gate/${encodeURIComponent(dupCode)}`);
    assert.strictEqual(gate.body.valid, true);
    const bg = await call('POST', '/api/emergency/break-glass', { code: dupCode, reason: 'UNCONSCIOUS' }, doctorToken);
    assert.strictEqual(bg.status, 200, 'the merged record\'s emergency code still works');
    assert.strictEqual(rt.emergencyEngine.getGrant(bg.body.grantId)!.patientId, survivorId, 'and opens the surviving record');
    const summary = rt.emergencyEngine.buildEmergencySummary(survivor, bg.body.grantId);
    assert.ok(summary.triageEssentials.allergies.some((a) => a.substance === 'Synthetic cotrimoxazole'), 'the merged record\'s allergy is in the emergency summary');
    assert.strictEqual((await call('GET', `/api/patients/${dupId}`)).body.mergedInto, survivorId);

    const unmerged = await call('POST', `/api/admin/mpi/merges/${mergeId}/unmerge`, {}, officer);
    assert.deepStrictEqual([unmerged.status, unmerged.body.merge.status], [200, 'UNDONE']);
    assert.strictEqual(snapshot(), before, 'unmerge restores both records, their histories and the review exactly');
    assert.deepStrictEqual(rt.clinicalStore.getLatestFinalRecords(survivorId, 'Condition').map(({ resource }) => (resource as any).code.text).includes('Synthetic asthma'), false);
    for (const action of ['PATIENT_MERGED', 'PATIENT_UNMERGED']) {
      const entries = rt.auditManager.getEntries().filter((e) => e.action === action && e.reason!.includes(mergeId));
      assert.deepStrictEqual(entries.map((e) => e.subjectId).sort(), [survivorId, dupId].sort(), `${action} audited for both records`);
    }
    assert.strictEqual(rt.auditManager.verifyChain().valid, true);
  });
});

describe('Identity verification never blocks emergency care', () => {
  test("Stubs report 'unavailable' (NIMC, Kenya); registration continues; break-glass, summary and card work", async () => {
    assert.deepStrictEqual(await new NimcVerifier().verify(), { status: 'unavailable', matchScore: 0, verifier: 'nimc-not-integrated' });
    assert.strictEqual((await new KenyaIdVerifier().verify()).status, 'unavailable');
    assert.ok(createIdentityVerifier({ DEMO_MODE: '0' })('NG') instanceof NimcVerifier, 'real data: the official channel (stub), never the synthetic register');
    assert.ok(createIdentityVerifier({})('NG') instanceof FakeIdentityVerifier);

    const registration = new PatientRegistrationService({
      seedData: rt.seedData, patientsById: rt.patientsById, patientsByCode: rt.patientsByCode, codeByPatient: rt.codeByPatient, auditManager: rt.auditManager,
      identity: rt.identity, mpi: rt.mpi, verifierFor: () => new NimcVerifier(), patientAuth: rt.patientAuth,
    });
    const officerAccount = rt.accounts.get(`records-${FACILITY}-demo`)!;
    const r = await registration.register(officerAccount, { firstName: 'Synthetic', lastName: 'Unverified', dateOfBirth: '1979-09-09', gender: 'male', identifiers: [{ country: 'NG', idType: 'NIN', idNumber: '95555555555' }] }, info);
    assert.strictEqual(r.outcome, 'created');
    assert.strictEqual(r.identity[0].status, 'unavailable', 'kept as unverified');
    const patient = rt.patientsById.get(r.patientId)!;

    const bg = await call('POST', '/api/emergency/break-glass', { code: r.emergencyCode, reason: 'UNCONSCIOUS' }, doctorToken);
    assert.strictEqual(bg.status, 200, JSON.stringify(bg.body));
    const summary = await call('GET', `/api/emergency/grants/${bg.body.grantId}/summary`, undefined, doctorToken);
    assert.strictEqual(summary.status, 200);
    assert.strictEqual(summary.body.summary.patient.fullName, 'Synthetic Unverified');
    assert.strictEqual(rt.offlineCardStore.issue(patient).card.version, 1, 'an offline card can be issued');
  });
});
