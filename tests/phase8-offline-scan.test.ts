import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { generateSeedData } from '../prisma/seed.ts';
import { AuditChainManager } from '../src/lib/audit/hashChain.ts';
import { NotificationDispatcher, ConsoleNotificationProvider } from '../src/lib/notifications/dispatcher.ts';
import { OfflineCardStore } from '../src/lib/emergency/offlineCardStore.ts';
import { OfflineScanService, PASS_VALIDITY_SECONDS } from '../src/lib/emergency/offlineScans.ts';
import { createCardKeyStore, getKid } from '../src/lib/crypto/cardKeys.ts';
import { signScanEvent, eventSigningInput, canonicalJson } from '../site/js/lib/offlineScan.js';
import type { PatientEntity } from '../src/lib/patient/profile.ts';

const subtle = globalThis.crypto.subtle;
const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);

/** Non-extractable device key pair, exactly as the scanner creates it. */
async function newDevice() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair;
  return { privateKey: kp.privateKey, publicJwk: await subtle.exportKey('jwk', kp.publicKey) };
}

function setup() {
  const seed = generateSeedData();
  const patientsById = new Map<string, PatientEntity>(seed.patients.map((p) => [p.patient.id, p.patient]));
  const auditManager = new AuditChainManager();
  const provider = new ConsoleNotificationProvider();
  const cardStore = new OfflineCardStore(auditManager);
  const svc = new OfflineScanService({
    auditManager, dispatcher: new NotificationDispatcher(provider), cardStore,
    clinicians: seed.clinicians, facilities: seed.facilities, patientsById,
  });
  const patient = seed.patients[0].patient;
  const clinician = seed.clinicians[0];
  return { seed, svc, auditManager, provider, cardStore, patient, clinician };
}

async function signedEvent(device: { privateKey: CryptoKey }, pass: string, patient: PatientEntity, over: Record<string, unknown> = {}) {
  return signScanEvent({
    eventId: crypto.randomUUID(),
    cardSub: patient.id,
    cardVersion: 1,
    cardKid: getKid(),
    reason: 'UNCONSCIOUS',
    scannedAt: new Date().toISOString(),
    pass,
    ...over,
  }, device.privateKey);
}

const META = { ipAddress: '127.0.0.1', userAgent: 'test' };
const scansFor = (audit: AuditChainManager) => audit.getEntries().filter((e) => e.action === 'OFFLINE_EMERGENCY_SCAN');

describe('1. Accepted scans are audited and notified', () => {
  test('A valid batch is accepted, audited, the chain verifies, and the patient is notified', async () => {
    const { svc, auditManager, provider, cardStore, patient, clinician } = setup();
    cardStore.issue(patient);
    const device = await newDevice();
    const dk = svc.bindDeviceKey(clinician.id, device.publicJwk);
    const { pass } = svc.issuePass(clinician.id, dk);
    const events = [await signedEvent(device, pass, patient), await signedEvent(device, pass, patient, { reason: 'OTHER', details: 'Found collapsed at bus stop' })];

    const results = svc.processBatch(events, META);
    assert.deepStrictEqual(results.map((r) => [r.status, r.cardStatus]), [['accepted', 'current'], ['accepted', 'current']]);

    const audits = scansFor(auditManager);
    assert.strictEqual(audits.length, 2);
    assert.strictEqual(audits[0].accessType, 'EMERGENCY_BREAK_GLASS');
    assert.strictEqual(audits[0].subjectId, patient.id);
    assert.strictEqual(audits[0].actorId, clinician.userId);
    assert.strictEqual(audits[0].facilityId, clinician.facilityId);
    assert.strictEqual(audits[0].resourceId, events[0].eventId);
    assert.match(audits[0].reason || '', /UNCONSCIOUS/);
    assert.ok(audits[0].reason?.includes(`device ${dk.slice(0, 12)}`));
    assert.match(audits[1].reason || '', /OTHER: Found collapsed at bus stop/);
    assert.strictEqual(auditManager.verifyChain().valid, true);

    const push = provider.sentPushLogs.filter((p) => p.toUserId === patient.id);
    assert.strictEqual(push.length, 2);
    assert.match(push[0].body, new RegExp(`^Your emergency card was scanned by ${clinician.fullName.replace(/\./g, '\\.')} at .+ on .+ UTC for reason: patient unconscious\\. Dispute it in the patient portal if this was not you\\.$`));
    assert.ok(!push[0].body.includes(patient.bloodGroup), 'no card data in the notification');

    const stored = svc.getEvent(events[0].eventId)!;
    assert.strictEqual(stored.status, 'ACCEPTED');
    assert.strictEqual(stored.deviceKeyThumbprint, dk);
    assert.strictEqual(stored.cardVersion, 1);
  });
});

describe('2. Idempotency', () => {
  test('Re-uploading the same eventId returns duplicate and writes no second audit entry', async () => {
    const { svc, auditManager, provider, patient, clinician } = setup();
    const device = await newDevice();
    const { pass } = svc.issuePass(clinician.id, svc.bindDeviceKey(clinician.id, device.publicJwk));
    const ev = await signedEvent(device, pass, patient);
    assert.strictEqual(svc.processBatch([ev], META)[0].status, 'accepted');
    const audits = auditManager.getEntries().length;
    const pushes = provider.sentPushLogs.length;

    const again = svc.processBatch([ev, ev], META);
    assert.deepStrictEqual(again.map((r) => r.status), ['duplicate', 'duplicate']);
    assert.strictEqual(auditManager.getEntries().length, audits);
    assert.strictEqual(provider.sentPushLogs.length, pushes);

    const reused = await signedEvent(device, pass, patient, { eventId: ev.eventId, reason: 'LIFE_THREATENING' });
    const r = svc.processBatch([reused], META)[0];
    assert.strictEqual(r.status, 'rejected');
    assert.match(r.reason || '', /already used/);
  });
});

describe('3. Rejections', () => {
  test('A forged pass is rejected (other signing key, or edited claims)', async () => {
    const { svc, auditManager, patient, clinician } = setup();
    const device = await newDevice();
    const dk = svc.bindDeviceKey(clinician.id, device.publicJwk);
    const attacker = createCardKeyStore(crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey);
    const forged = attacker.signCompactJws({ typ: 'clinician-pass', iss: 'medistry', sub: clinician.id, fac: clinician.facilityId, iat: nowSec(), exp: nowSec() + DAY, dk });
    const { pass } = svc.issuePass(clinician.id, dk);
    const [h, p, s] = pass.split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    const edited = `${h}.${Buffer.from(JSON.stringify({ ...claims, exp: claims.exp + 365 * DAY })).toString('base64url')}.${s}`;

    const results = svc.processBatch([await signedEvent(device, forged, patient), await signedEvent(device, edited, patient)], META);
    assert.deepStrictEqual(results.map((r) => r.status), ['rejected', 'rejected']);
    assert.match(results[0].reason || '', /pass rejected: Unknown signing key/);
    assert.match(results[1].reason || '', /pass rejected: Cryptographic signature mismatch/);
    assert.strictEqual(scansFor(auditManager).length, 0);
  });

  test('A wrong device signature is rejected (other device, or a field changed after signing)', async () => {
    const { svc, patient, clinician } = setup();
    const device = await newDevice();
    const other = await newDevice();
    const { pass } = svc.issuePass(clinician.id, svc.bindDeviceKey(clinician.id, device.publicJwk));
    const byOther = await signedEvent(other, pass, patient);
    const changed = { ...(await signedEvent(device, pass, patient)), reason: 'LIFE_THREATENING' };
    const sigOnly = { ...(await signedEvent(device, pass, patient)), deviceSig: 'AAAA' };
    const results = svc.processBatch([byOther, changed, sigOnly], META);
    assert.deepStrictEqual(results.map((r) => [r.status, r.reason]), [
      ['rejected', 'device signature does not match'],
      ['rejected', 'device signature does not match'],
      ['rejected', 'device signature does not match'],
    ]);
  });

  test('A pass that had expired at scan time is rejected; one that expired only after the scan is accepted', async () => {
    const { svc, patient, clinician } = setup();
    const device = await newDevice();
    const dk = svc.bindDeviceKey(clinician.id, device.publicJwk);
    const scannedAt = nowSec() - 10 * DAY;

    const expiredAtScan = svc.issuePass(clinician.id, dk, scannedAt - PASS_VALIDITY_SECONDS - 60).pass;
    const validAtScan = svc.issuePass(clinician.id, dk, scannedAt - 2 * DAY).pass; // expired 5 days ago, before upload
    const results = svc.processBatch([
      await signedEvent(device, expiredAtScan, patient, { scannedAt: new Date(scannedAt * 1000).toISOString() }),
      await signedEvent(device, validAtScan, patient, { scannedAt: new Date(scannedAt * 1000).toISOString() }),
    ], META);
    assert.strictEqual(results[0].status, 'rejected');
    assert.match(results[0].reason || '', /expired/);
    assert.strictEqual(results[1].status, 'accepted', results[1].reason);
  });

  test('A suspended clinician is rejected, and cannot get a new pass', async () => {
    const { svc, patient, clinician } = setup();
    const device = await newDevice();
    const dk = svc.bindDeviceKey(clinician.id, device.publicJwk);
    const { pass } = svc.issuePass(clinician.id, dk);
    const ev = await signedEvent(device, pass, patient);
    clinician.status = 'SUSPENDED';
    const r = svc.processBatch([ev], META)[0];
    assert.strictEqual(r.status, 'rejected');
    assert.match(r.reason || '', /suspended/);
    assert.throws(() => svc.issuePass(clinician.id, dk), /Only verified clinicians/);
  });

  test('Stale (over 30 days) and future (over 5 minutes) timestamps are rejected', async () => {
    const { svc, patient, clinician } = setup();
    const device = await newDevice();
    const dk = svc.bindDeviceKey(clinician.id, device.publicJwk);
    const old = nowSec() - 31 * DAY;
    const stale = await signedEvent(device, svc.issuePass(clinician.id, dk, old - 60).pass, patient, { scannedAt: new Date(old * 1000).toISOString() });
    const future = await signedEvent(device, svc.issuePass(clinician.id, dk).pass, patient, { scannedAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    const small = await signedEvent(device, svc.issuePass(clinician.id, dk).pass, patient, { scannedAt: new Date(Date.now() + 2 * 60_000).toISOString() });
    const results = svc.processBatch([stale, future, small], META);
    assert.match(results[0].reason || '', /more than 30 days old/);
    assert.match(results[1].reason || '', /more than 5 minutes in the future/);
    assert.strictEqual(results[2].status, 'accepted', 'small clock skew is allowed');
  });

  test('Malformed events, oversized batches, unknown patients and private device keys are rejected', async () => {
    const { svc, patient, clinician } = setup();
    const device = await newDevice();
    const { pass } = svc.issuePass(clinician.id, svc.bindDeviceKey(clinician.id, device.publicJwk));
    const results = svc.processBatch([
      { eventId: 'not-a-uuid' },
      await signedEvent(device, pass, patient, { reason: 'BORED' }),
      await signedEvent(device, pass, patient, { reason: 'OTHER' }),
      await signedEvent(device, pass, patient, { cardSub: 'no-such-patient' }),
    ], META);
    assert.deepStrictEqual(results.map((r) => r.status), ['rejected', 'rejected', 'rejected', 'rejected']);
    assert.match(results[2].reason || '', /required for OTHER/);
    assert.match(results[3].reason || '', /not a known patient/);
    assert.throws(() => svc.processBatch(new Array(51).fill({}), META), /At most 50/);
    assert.throws(() => svc.processBatch([], META), /non-empty/);
    const priv = await subtle.exportKey('jwk', (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])).privateKey);
    assert.throws(() => svc.bindDeviceKey(clinician.id, priv), /Never send a private key/);
  });
});

describe('4. Card status', () => {
  test('A superseded card version returns cardStatus superseded; a revoked one returns revoked', async () => {
    const { svc, cardStore, patient, clinician } = setup();
    cardStore.issue(patient);
    cardStore.issue(patient);
    const device = await newDevice();
    const { pass } = svc.issuePass(clinician.id, svc.bindDeviceKey(clinician.id, device.publicJwk));
    const results = svc.processBatch([
      await signedEvent(device, pass, patient, { cardVersion: 1 }),
      await signedEvent(device, pass, patient, { cardVersion: 2 }),
    ], META);
    assert.deepStrictEqual(results.map((r) => [r.status, r.cardStatus]), [['accepted', 'superseded'], ['accepted', 'current']]);

    cardStore.revoke(patient.id, 2, 'Card lost');
    const after = svc.processBatch([await signedEvent(device, pass, patient, { cardVersion: 2 })], META)[0];
    assert.strictEqual(after.cardStatus, 'revoked');
  });

  test('The signed bytes are canonical JSON of the event fields only (no card contents)', () => {
    const input = eventSigningInput({ scannedAt: 't', eventId: 'e', pass: 'p', cardSub: 's', cardVersion: 1, cardKid: 'k', reason: 'UNCONSCIOUS', deviceSig: 'x', e: { bg: 'O+' } });
    assert.strictEqual(input, '{"cardKid":"k","cardSub":"s","cardVersion":1,"eventId":"e","pass":"p","reason":"UNCONSCIOUS","scannedAt":"t"}');
    assert.strictEqual(canonicalJson({ b: 1, a: { d: undefined, c: [2, 1] } }), '{"a":{"c":[2,1]},"b":1}');
  });
});

describe('5. End to end over HTTP (login pass, device key, upload, access log, dispute)', () => {
  const PORT = 39000 + Math.floor(Math.random() * 1000);
  const base = `http://localhost:${PORT}`;
  let server: ChildProcess;
  const seed = generateSeedData();
  const clinician = seed.clinicians[1];
  const patient = seed.patients[2].patient;
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

  const totp = async () => (await (await fetch(`${base}/api/demo/totp/${clinician.id}`)).json()).code;

  test('Login without a device key is unchanged; with one it returns a pass bound to that key', async () => {
    const plain = await (await post('/api/clinician/login', { clinicianId: clinician.id, totp: await totp() })).json();
    assert.ok(plain.token);
    assert.strictEqual('pass' in plain, false);

    const device = await newDevice();
    const res = await post('/api/clinician/login', { clinicianId: clinician.id, totp: await totp(), devicePublicJwk: device.publicJwk });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.token && data.pass && data.deviceKeyThumbprint);
    const claims = JSON.parse(Buffer.from(data.pass.split('.')[1], 'base64url').toString());
    assert.strictEqual(claims.typ, 'clinician-pass');
    assert.strictEqual(claims.sub, clinician.id);
    assert.strictEqual(claims.lic, clinician.licenseNumber);
    assert.strictEqual(claims.dk, data.deviceKeyThumbprint);
    assert.strictEqual(claims.exp - claims.iat, 7 * DAY);

    // A second device binds through /api/clinician/device-key with the session
    const second = await newDevice();
    const bound = await (await post('/api/clinician/device-key', { publicJwk: second.publicJwk }, data.token)).json();
    assert.ok(bound.pass);
    assert.notStrictEqual(bound.deviceKeyThumbprint, data.deviceKeyThumbprint);
    assert.strictEqual((await post('/api/clinician/device-key', { publicJwk: second.publicJwk })).status, 401);

    // Upload a scan without any session: the pass and the device signature authenticate it
    const ev = await signScanEvent({
      eventId: crypto.randomUUID(), cardSub: patient.id, cardVersion: 1, cardKid: 'kid', reason: 'LIFE_THREATENING',
      scannedAt: new Date().toISOString(), pass: data.pass,
    }, device.privateKey);
    const up = await (await post('/api/emergency/offline-scans', { events: [ev] })).json();
    assert.deepStrictEqual(up.results.map((r: { status: string }) => r.status), ['accepted']);
    assert.strictEqual((await (await post('/api/emergency/offline-scans', { events: [ev] })).json()).results[0].status, 'duplicate');
    assert.strictEqual((await post('/api/emergency/offline-scans', { events: new Array(51).fill(ev) })).status, 400);

    // Patient sees it in the access log and alerts, and can dispute it by the offline scan event id
    const { logs } = await (await fetch(`${base}/api/patients/${patient.id}/access-log`)).json();
    assert.ok(logs.some((l: { action: string }) => l.action === 'OFFLINE_EMERGENCY_SCAN'));
    const { notifications } = await (await fetch(`${base}/api/patients/${patient.id}/notifications`)).json();
    assert.ok(notifications.some((n: { message: string }) => /Your emergency card was scanned by/.test(n.message)));
    const dispute = await post(`/api/patients/${patient.id}/disputes`, { offlineScanEventId: ev.eventId, reason: 'This was not me' });
    assert.strictEqual(dispute.status, 200);
    assert.strictEqual((await dispute.json()).offlineScanEventId, ev.eventId);
    const other = seed.patients[3].patient;
    assert.strictEqual((await post(`/api/patients/${other.id}/disputes`, { offlineScanEventId: ev.eventId, reason: 'Not my scan' })).status, 404);

    const chain = await (await fetch(`${base}/api/audit/verify`)).json();
    assert.strictEqual(chain.valid, true);
  });
});
