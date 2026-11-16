// Phase 19: the audit agent. Each rule fires on a crafted scenario and stays quiet on normal use; flags go to a
// platform-admin review queue; a human decides and nothing happens to the clinician automatically.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createRuntime, type Runtime } from '../src/lib/runtime.ts';
import { createMemoryPersistence } from '../src/lib/data/memory/persistence.ts';
import { createPortalApi } from '../src/lib/site/portalApi.ts';
import { generateTotp } from '../src/lib/auth/security.ts';
import { anomalyConfigFromEnv } from '../src/lib/audit/anomalyAgent.ts';
import { signScanEvent } from '../site/js/lib/offlineScan.js';
import type { SeedClinician } from '../prisma/seed.ts';
import type { PatientEntity } from '../src/lib/patient/profile.ts';

const HOUR = 3_600_000;
const info = { ipAddress: '127.0.0.1', userAgent: 'test' };
const fresh = () => createRuntime(createMemoryPersistence());
const doctor = (rt: Runtime, country = 'NG') => rt.seedData.clinicians.find((c) => c.countryCode === country && c.status === 'VERIFIED')!;
const patients = (rt: Runtime) => rt.seedData.patients.map((p) => p.patient);

async function breakGlass(rt: Runtime, c: SeedClinician, p: PatientEntity) {
  const { grant } = await rt.emergencyEngine.initiateBreakGlass({
    patient: p, emergencyCode: rt.codeByPatient.get(p.id)!.formattedCode,
    actor: { userId: c.userId, role: 'DOCTOR', clinicianId: c.id, facilityId: c.facilityId, isVerifiedClinician: true },
    treatingDoctorName: c.fullName, facilityId: c.facilityId, facilityName: 'Synthetic ER', reason: 'UNCONSCIOUS',
  });
  return grant;
}

/** An offline card scan by the clinician's bound device, uploaded like the scanner does. */
async function offlineScan(rt: Runtime, c: SeedClinician, p: PatientEntity) {
  const kp = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair;
  const dk = rt.offlineScans.bindDeviceKey(c.id, await crypto.webcrypto.subtle.exportKey('jwk', kp.publicKey));
  const { pass } = rt.offlineScans.issuePass(c.id, dk);
  const card = rt.offlineCardStore.getCurrentIssued(p) || rt.offlineCardStore.issue(p);
  const ev = await signScanEvent({ eventId: crypto.randomUUID(), cardSub: p.id, cardVersion: card.card.version, cardKid: card.card.kid, reason: 'UNCONSCIOUS', scannedAt: new Date().toISOString(), pass }, kp.privateKey);
  const [r] = rt.offlineScans.processBatch([ev], info);
  assert.strictEqual(r.status, 'accepted', JSON.stringify(r));
  return ev.eventId as string;
}

/** The clinician's facility records an encounter for the patient (the follow-up the rule looks for). */
function encounter(rt: Runtime, c: SeedClinician, p: PatientEntity) {
  rt.clinicalStore.importRecord(p.id, { resourceType: 'Encounter', id: '', status: 'finished', class: { code: 'EMER' }, subject: { reference: `Patient/${p.id}` } } as any,
    { facilityId: c.facilityId, externalKey: crypto.randomUUID(), authorClinicianId: c.id, clientId: 'test' });
}

const rules = (flags: Array<{ rule: string }>) => flags.map((f) => f.rule).sort();

describe('Rules: each fires on a crafted scenario, none on normal use', () => {
  test('Normal use: a few emergency accesses, each followed by an encounter, in the clinician\'s own country', async () => {
    const rt = await fresh();
    const c = doctor(rt);
    const [p1, p2, p3] = patients(rt);
    assert.deepStrictEqual(rt.anomalyAgent.evaluate(Date.now() + 100 * HOUR), [], 'the seed itself raises nothing');
    await breakGlass(rt, c, p1);
    encounter(rt, c, p1);
    await offlineScan(rt, c, p2);
    encounter(rt, c, p2);
    await breakGlass(rt, c, p3);
    encounter(rt, c, p3);
    assert.deepStrictEqual(rt.anomalyAgent.evaluate(Date.now() + 25 * HOUR), []);
    assert.deepStrictEqual(rt.anomalyAgent.run(Date.now() + 25 * HOUR), []);
  });

  test('BREAK_GLASS_PER_SHIFT: more than N emergency accesses by one clinician in one shift (N = 3 by default)', async () => {
    const rt = await fresh();
    const c = doctor(rt);
    const ps = patients(rt);
    for (const p of ps.slice(0, 3)) await breakGlass(rt, c, p);
    assert.deepStrictEqual(rules(rt.anomalyAgent.evaluate()), [], 'three is within the threshold');
    await offlineScan(rt, c, ps[3]); // offline scans count as emergency access too
    const flags = rt.anomalyAgent.evaluate();
    assert.deepStrictEqual(rules(flags), ['BREAK_GLASS_PER_SHIFT']);
    assert.strictEqual(flags[0].eventRefs.length, 4);
    assert.strictEqual(flags[0].clinicianId, c.id);
    assert.match(flags[0].explanation, /4 emergency accesses \(3 break-glass, 1 offline scans\) within 12 hours/);
    // Another clinician's accesses are counted separately
    const other = rt.seedData.clinicians.find((x) => x.countryCode === 'NG' && x.id !== c.id)!;
    await breakGlass(rt, other, ps[4]);
    assert.deepStrictEqual(rules(rt.anomalyAgent.evaluate()), ['BREAK_GLASS_PER_SHIFT']);
    // Spread over two shifts: no flag
    rt.anomalyAgent.config = { ...rt.anomalyAgent.config, shiftHours: 1 };
    assert.deepStrictEqual(rules(rt.anomalyAgent.evaluate()), ['BREAK_GLASS_PER_SHIFT'], 'all four were within the hour');
    rt.anomalyAgent.config = { ...rt.anomalyAgent.config, breakGlassPerShift: 4 };
    assert.deepStrictEqual(rules(rt.anomalyAgent.evaluate()), [], 'configurable threshold');
  });

  test('SCAN_WITHOUT_ENCOUNTER: no encounter recorded within the waiting time; checked only once it has passed', async () => {
    const rt = await fresh();
    const c = doctor(rt);
    const [p1, p2] = patients(rt);
    const grant = await breakGlass(rt, c, p1);
    const scan = await offlineScan(rt, c, p2);
    encounter(rt, c, p2);
    assert.deepStrictEqual(rt.anomalyAgent.evaluate(Date.now() + 1 * HOUR), [], 'not due yet (24 hours by default)');
    const flags = rt.anomalyAgent.evaluate(Date.now() + 25 * HOUR);
    assert.deepStrictEqual(rules(flags), ['SCAN_WITHOUT_ENCOUNTER']);
    assert.deepStrictEqual(flags[0].eventRefs, [`grant:${grant.id}`], `the scan with an encounter (${scan}) is not flagged`);
    // An encounter at another facility does not count; one at the clinician's facility does
    const elsewhere = rt.seedData.clinicians.find((x) => x.facilityId !== c.facilityId && x.countryCode === 'NG')!;
    encounter(rt, elsewhere, p1);
    assert.deepStrictEqual(rules(rt.anomalyAgent.evaluate(Date.now() + 25 * HOUR)), ['SCAN_WITHOUT_ENCOUNTER']);
    encounter(rt, c, p1);
    assert.deepStrictEqual(rt.anomalyAgent.evaluate(Date.now() + 25 * HOUR), []);
  });

  test('SCAN_OUTSIDE_COUNTRY: a clinician whose facility is in KE opens an NG record (break-glass and offline scan)', async () => {
    const rt = await fresh();
    const ke = doctor(rt, 'KE');
    const [p1, p2] = patients(rt);
    assert.strictEqual(p1.countryCode, 'NG');
    await breakGlass(rt, ke, p1);
    await offlineScan(rt, ke, p2);
    const flags = rt.anomalyAgent.evaluate();
    assert.deepStrictEqual(rules(flags), ['SCAN_OUTSIDE_COUNTRY', 'SCAN_OUTSIDE_COUNTRY']);
    for (const f of flags) assert.match(f.explanation, /facility is in KE: the patient's record is from NG\. Cross-border emergency care can be legitimate/);
    // The same clinician with a Kenyan patient: no flag
    const rt2 = await fresh();
    const keP = rt2.seedData.patients[0].patient;
    keP.countryCode = 'KE';
    await breakGlass(rt2, doctor(rt2, 'KE'), keP);
    assert.deepStrictEqual(rt2.anomalyAgent.evaluate(), []);
  });

  test('REPEATED_PATIENT_SCANS: the same patient again and again by the same clinician (3 in 24 hours by default)', async () => {
    const rt = await fresh();
    const c = doctor(rt);
    const [p1] = patients(rt);
    await offlineScan(rt, c, p1);
    await offlineScan(rt, c, p1);
    assert.deepStrictEqual(rt.anomalyAgent.evaluate(), [], 'two scans of one patient is normal');
    await offlineScan(rt, c, p1);
    const flags = rt.anomalyAgent.evaluate();
    assert.deepStrictEqual(rules(flags), ['REPEATED_PATIENT_SCANS'], 'three accesses is also within the per-shift threshold');
    assert.strictEqual(flags[0].eventRefs.length, 3);
    // Different clinicians each scanning once are not "repeated"
    const rt2 = await fresh();
    const [a, b, d] = rt2.seedData.clinicians.filter((x) => x.countryCode === 'NG').slice(0, 3);
    for (const x of [a, b, d]) await offlineScan(rt2, x, rt2.seedData.patients[0].patient);
    assert.deepStrictEqual(rt2.anomalyAgent.evaluate(), []);
  });

  test('Thresholds come from the environment; bad values fall back to the defaults', () => {
    assert.deepStrictEqual(anomalyConfigFromEnv({}), { breakGlassPerShift: 3, shiftHours: 12, encounterHours: 24, repeatCount: 3, repeatHours: 24, lookbackDays: 30 });
    const c = anomalyConfigFromEnv({ ANOMALY_BREAK_GLASS_PER_SHIFT: '6', ANOMALY_SHIFT_HOURS: 'abc', ANOMALY_REPEAT_COUNT: '1' });
    assert.deepStrictEqual([c.breakGlassPerShift, c.shiftHours, c.repeatCount], [6, 12, 2]);
  });
});

describe('Review queue: humans decide, nothing automatic', () => {
  let rt: Runtime;
  let base = '';
  let server: http.Server;
  let platformToken = '';
  let facilityToken = '';
  const call = async (method: string, p: string, body?: unknown, token?: string) => {
    const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) as any };
  };
  const adminToken = async (id: string) => (await call('POST', '/api/admin/login', { adminId: id, totp: generateTotp(rt.staff.demoTotpSecret(id)!) })).body.token;

  before(async () => {
    rt = await fresh();
    const api = createPortalApi({ ...rt, notifications: rt.consoleProvider, offlineCards: rt.offlineCardStore, dataDir: path.join(os.tmpdir(), 'medistry-phase19') });
    server = http.createServer(async (req, res) => { if (!(await api(req, res, new URL(req.url || '/', 'http://localhost')))) { res.writeHead(404); res.end('{}'); } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    platformToken = await adminToken('admin-platform-demo');
    facilityToken = await adminToken('admin-fac-luth-001-demo');
  });
  after(() => { server.close(); });

  test('Flags are stored once, audited, and contain no names or patient identifiers', async () => {
    const c = doctor(rt);
    for (const p of patients(rt).slice(0, 4)) await breakGlass(rt, c, p);
    const created = rt.anomalyAgent.run();
    assert.deepStrictEqual(rules(created), ['BREAK_GLASS_PER_SHIFT']);
    assert.deepStrictEqual(rt.anomalyAgent.run(), [], 'the same finding is not flagged twice');
    assert.ok(rt.auditManager.getEntries().some((e) => e.action === 'ANOMALY_FLAGGED' && e.resourceId === created[0].id && e.actorId === 'audit-agent'));
    const text = JSON.stringify(created);
    for (const p of patients(rt)) assert.ok(!text.includes(p.id), 'no patient id');
    assert.ok(!text.includes(c.fullName), 'no clinician name');
  });

  test('Only platform admins see and review the queue; a decision needs a note; the clinician is untouched', async () => {
    assert.strictEqual((await call('GET', '/api/admin/anomalies', undefined, facilityToken)).status, 403);
    const list = await call('GET', '/api/admin/anomalies', undefined, platformToken);
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body.flags.length, 1);
    assert.strictEqual(list.body.rules.breakGlassPerShift, 3);
    const flag = list.body.flags[0];
    assert.strictEqual('dedupeKey' in flag, false);

    assert.strictEqual((await call('POST', `/api/admin/anomalies/${flag.id}/review`, { decision: 'confirm', note: 'x' }, platformToken)).status, 400, 'note required');
    assert.strictEqual((await call('POST', `/api/admin/anomalies/${flag.id}/review`, { decision: 'punish', note: 'Synthetic note' }, platformToken)).status, 400);
    assert.strictEqual((await call('POST', `/api/admin/anomalies/${flag.id}/review`, { decision: 'confirm', note: 'Synthetic note' }, facilityToken)).status, 403);
    const c = rt.seedData.clinicians.find((x) => x.id === flag.clinicianId)!;
    const before = { status: c.status, disabled: rt.accounts.get(c.userId)?.disabled };
    const reviewed = await call('POST', `/api/admin/anomalies/${flag.id}/review`, { decision: 'confirm', note: 'Synthetic: refer to clinical governance' }, platformToken);
    assert.deepStrictEqual([reviewed.status, reviewed.body.flag.status, reviewed.body.flag.reviewNote], [200, 'CONFIRMED', 'Synthetic: refer to clinical governance']);
    assert.deepStrictEqual({ status: c.status, disabled: rt.accounts.get(c.userId)?.disabled }, before, 'no automatic action on the clinician');
    assert.strictEqual((await call('POST', `/api/admin/anomalies/${flag.id}/review`, { decision: 'dismiss', note: 'Synthetic again' }, platformToken)).status, 409);
    assert.ok(rt.auditManager.getEntries().some((e) => e.action === 'ANOMALY_FLAG_REVIEWED' && e.resourceId === flag.id && e.actorId === 'admin-platform-demo'));
    assert.strictEqual((await call('GET', '/api/admin/anomalies', undefined, platformToken)).body.flags.length, 0, 'no longer open');
    assert.strictEqual((await call('GET', '/api/admin/anomalies?status=CONFIRMED', undefined, platformToken)).body.flags.length, 1);
    assert.strictEqual(rt.auditManager.verifyChain().valid, true);
  });

  test('A platform admin can run the agent on demand', async () => {
    assert.strictEqual((await call('POST', '/api/admin/anomalies/run', {}, facilityToken)).status, 403);
    const r = await call('POST', '/api/admin/anomalies/run', {}, platformToken);
    assert.deepStrictEqual([r.status, r.body.created], [200, 0]);
  });
});
