// Storage layer tests that need no database: storage selection, secrets, entity <-> row mapping (the code the
// Prisma repositories use), and a full write-through + restart cycle through a recording repository that
// stores the same rows Prisma would. Real PostgreSQL is covered by tests/postgres-storage.test.ts in CI.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { storageMode, assertPostgresSecrets } from '../src/lib/data/storage.ts';
import { createRuntime, type Runtime } from '../src/lib/runtime.ts';
import * as M from '../src/lib/data/prisma/mappers.ts';
import { GENESIS_HASH } from '../src/lib/audit/hashChain.ts';
import { decryptPatientDemographics } from '../src/lib/patient/profile.ts';
import { signScanEvent } from '../site/js/lib/offlineScan.js';
import type { Persistence, Snapshot } from '../src/lib/data/repositories.ts';

/** Stores rows exactly as the Prisma repositories would (same mappers), in maps instead of tables. */
function recordingPersistence() {
  const t = {
    facility: new Map<string, any>(), clinician: new Map<string, any>(), patient: new Map<string, any>(), code: new Map<string, any>(),
    record: new Map<string, any>(), audit: [] as any[], consentRequest: new Map<string, any>(), consentGrant: new Map<string, any>(),
    grant: new Map<string, any>(), dispute: new Map<string, any>(), card: new Map<string, any>(), scan: new Map<string, any>(),
    deviceKey: new Map<string, any>(), flag: new Map<string, any>(), notification: [] as any[],
  };
  let refusedAudit = 0;
  const p: Persistence & { tables: typeof t; refusedAudit: () => number } = {
    mode: 'postgres',
    tables: t,
    refusedAudit: () => refusedAudit,
    saveFacility: (f) => t.facility.set(f.id, M.facilityToRow(f)),
    saveClinician: (c) => t.clinician.set(c.id, M.clinicianToRows(c).clinician),
    savePatient: (x) => t.patient.set(x.id, M.patientToRows(x).patient),
    saveEmergencyCode: (c) => { const r = M.codeToRow(c); t.code.set(r.codeHash, { ...(t.code.get(r.codeHash) || {}), ...r }); },
    saveRecord: (r) => t.record.set(r.id, M.recordToRow(r)),
    saveRecordFlag: (f) => t.flag.set(f.id, M.recordFlagToRow(f)),
    saveConsentRequest: (q) => t.consentRequest.set(q.id, M.consentRequestToRow(q)),
    saveConsentGrant: (g) => t.consentGrant.set(g.id, M.consentGrantToRow(g)),
    saveEmergencyGrant: (g) => t.grant.set(g.id, M.emergencyGrantToRow(g)),
    saveDispute: (d) => t.dispute.set(d.ticketId, M.disputeToRow(d)),
    saveOfflineCard: (c, token) => t.card.set(c.id, M.offlineCardToRow(c, token)),
    saveScanEvent: (e) => t.scan.set(e.id, M.scanEventToRow(e)),
    saveDeviceKey: (k) => t.deviceKey.set(`${k.clinicianId}:${k.thumbprint}`, M.deviceKeyToRow(k)),
    saveNotification: (n) => t.notification.push(M.notificationToRow(n)),
    appendAudit: (e) => {
      // Same continuity rule as the Prisma repository's locked append.
      const last = t.audit.at(-1);
      if (e.sequenceNumber !== (last?.sequenceNumber ?? 0) + 1 || e.previousHash !== (last?.currentHash ?? GENESIS_HASH)) { refusedAudit++; return; }
      t.audit.push(M.auditToRow(e));
    },
    async loadSnapshot(): Promise<Snapshot | null> {
      if (!t.patient.size) return null; // first start: behave like empty memory storage so the runtime seeds
      return {
        facilities: [...t.facility.values()].map(M.rowToFacility), clinicians: [...t.clinician.values()].map(M.rowToClinician),
        patients: [...t.patient.values()].map(M.rowToPatient), emergencyCodes: [...t.code.values()].map(M.rowToCode),
        records: [...t.record.values()].map(M.rowToRecord), audit: t.audit.map(M.rowToAudit),
        consentRequests: [...t.consentRequest.values()].map(M.rowToConsentRequest), consentGrants: [...t.consentGrant.values()].map(M.rowToConsentGrant),
        emergencyGrants: [...t.grant.values()].map(M.rowToEmergencyGrant), disputes: [...t.dispute.values()].map(M.rowToDispute),
        offlineCards: [...t.card.values()].map(M.rowToOfflineCard), scanEvents: [...t.scan.values()].map(M.rowToScanEvent),
        deviceKeys: [...t.deviceKey.values()].map(M.rowToDeviceKey), recordFlags: [...t.flag.values()].map(M.rowToRecordFlag),
        notifications: t.notification.map(M.rowToNotification),
      };
    },
    flush: async () => {}, close: async () => {},
    stats: () => ({ mode: 'postgres', pendingWrites: 0, failedWrites: refusedAudit }),
  };
  return p;
}

/** Exercises every kind of write the app makes. */
async function doEverything(rt: Runtime) {
  const patient = rt.seedData.patients[0].patient;
  const doctor = rt.seedData.clinicians.find((c) => c.facilityId === patient.primaryFacilityId)!;
  const other = rt.seedData.clinicians.find((c) => c.id !== doctor.id && c.countryCode === 'NG')!;
  const actor = { userId: doctor.userId, role: 'DOCTOR' as const, clinicianId: doctor.id, facilityId: doctor.facilityId, isVerifiedClinician: true };

  const card = rt.offlineCardStore.issue(patient);
  const req = rt.consentManager.createAccessRequest({
    patientId: patient.id, clinicianId: doctor.id, clinicianName: doctor.fullName, facilityId: doctor.facilityId,
    facilityName: 'Synthetic', requestedScopes: ['all'], durationPreset: 'ONE_VISIT', clinicalReason: 'Synthetic follow-up reason',
  });
  const grant = rt.consentManager.approveInApp(req.requestId, patient.id);
  const { grant: bg } = await rt.emergencyEngine.initiateBreakGlass({
    patient, emergencyCode: rt.codeByPatient.get(patient.id)!.formattedCode, actor, treatingDoctorName: doctor.fullName,
    facilityId: doctor.facilityId, facilityName: 'Synthetic ER', reason: 'OTHER', reasonDetails: 'Synthetic break-glass detail',
  });
  rt.emergencyEngine.coSignForFullHistory({ grantId: bg.id, primaryClinicianId: doctor.id, coSignClinicianId: other.id, coSignDoctorName: other.fullName, coSignReason: 'Synthetic second opinion' });

  const kp = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair;
  const dk = rt.offlineScans.bindDeviceKey(doctor.id, await globalThis.crypto.subtle.exportKey('jwk', kp.publicKey));
  const { pass } = rt.offlineScans.issuePass(doctor.id, dk);
  const ev = await signScanEvent({ eventId: crypto.randomUUID(), cardSub: patient.id, cardVersion: 1, cardKid: card.card.kid, reason: 'OTHER', details: 'Synthetic scan detail', scannedAt: new Date().toISOString(), pass }, kp.privateKey);
  assert.strictEqual(rt.offlineScans.processBatch([ev], { ipAddress: '127.0.0.1', userAgent: 't' })[0].status, 'accepted');

  const rec = rt.clinicalStore.getLatestFinalRecords(patient.id, 'Condition')[0].record;
  const flag = rt.recordFlags.flag(patient.id, rec.id, 'Synthetic flag note');
  const audit = rt.auditManager.getEntries().find((e) => e.action === 'OFFLINE_EMERGENCY_SCAN')!;
  const ticket = rt.accessLogManager.disputeAccess(patient.id, audit.id, 'Synthetic dispute reason');
  patient.preferredLocale = 'sw';
  rt.persistence.savePatient(patient);
  return { patient, card, grant, bg, ev, flag, ticket };
}

describe('Storage selection', () => {
  test('Memory by default; Postgres only with STORAGE=postgres and DATABASE_URL; secrets required', () => {
    assert.strictEqual(storageMode({}), 'memory');
    assert.strictEqual(storageMode({ STORAGE: 'memory', DATABASE_URL: 'postgresql://x' }), 'memory');
    assert.strictEqual(storageMode({ DATABASE_URL: 'postgresql://x' }), 'memory');
    assert.strictEqual(storageMode({ STORAGE: 'postgres', DATABASE_URL: 'postgresql://x' }), 'postgres');
    assert.throws(() => storageMode({ STORAGE: 'postgres' }), /needs DATABASE_URL/);
    assert.throws(() => assertPostgresSecrets({}), /FIELD_ENCRYPTION_KEY.*JWT_SECRET.*OFFLINE_CARD_PRIVATE_KEY/);
    assert.doesNotThrow(() => assertPostgresSecrets({ FIELD_ENCRYPTION_KEY: 'a'.repeat(64), JWT_SECRET: 'b'.repeat(32), OFFLINE_CARD_PRIVATE_KEY: 'x' }));
  });

  test('npm run seed refuses DEMO_MODE=0 and never writes', () => {
    const r = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/seed.ts'], {
      env: { ...process.env, DEMO_MODE: '0', STORAGE: 'postgres', DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/none' }, encoding: 'utf8',
    });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /Refusing to seed: DEMO_MODE=0/);
  });
});

describe('Write-through and restart (recording repository, same rows as Postgres)', () => {
  test('Every write is mirrored, and a restarted runtime rebuilds the same state', async () => {
    const store = recordingPersistence();
    const a = await createRuntime(store);
    const did = await doEverything(a);
    assert.strictEqual(store.refusedAudit(), 0, 'the audit chain was appended in order');
    for (const [name, table] of Object.entries(store.tables)) {
      const size = table instanceof Map ? table.size : table.length;
      assert.ok(size > 0, `${name} rows were written`);
    }

    const b = await createRuntime(store); // "restart": rebuilt only from stored rows
    const same = (x: unknown, y: unknown, what: string) => assert.deepStrictEqual(JSON.parse(JSON.stringify(x)), JSON.parse(JSON.stringify(y)), what);
    same([...b.patientsById.values()], [...a.patientsById.values()], 'patients');
    same([...b.codeByPatient], [...a.codeByPatient], 'emergency codes');
    same(b.auditManager.getEntries(), a.auditManager.getEntries(), 'audit chain');
    assert.strictEqual(b.auditManager.verifyChain().valid, true);
    same(b.offlineCardStore.getCurrentIssued(b.patientsById.get(did.patient.id)!), a.offlineCardStore.getCurrentIssued(did.patient), 'current card and token');
    same(b.offlineCardStore.list(did.patient.id), a.offlineCardStore.list(did.patient.id), 'card rows');
    same(b.consentManager.getPatientConsents(did.patient.id), a.consentManager.getPatientConsents(did.patient.id), 'consents');
    same(b.emergencyEngine.getGrant(did.bg.id), a.emergencyEngine.getGrant(did.bg.id), 'break-glass grant with co-sign');
    same(b.offlineScans.getEvent(did.ev.eventId), a.offlineScans.getEvent(did.ev.eventId), 'scan event');
    same(b.recordFlags.forPatient(did.patient.id), a.recordFlags.forPatient(did.patient.id), 'flags');
    same(b.accessLogManager.getOpenDisputes(), a.accessLogManager.getOpenDisputes(), 'disputes');
    same(b.consoleProvider.sentPushLogs, a.consoleProvider.sentPushLogs, 'notifications');
    same(b.consoleProvider.sentSmsLogs, a.consoleProvider.sentSmsLogs, 'SMS log');
    for (const id of a.patientsById.keys()) {
      same(b.clinicalStore.getLatestFinalRecords(id, 'Encounter'), a.clinicalStore.getLatestFinalRecords(id, 'Encounter'), 'records');
    }
    assert.strictEqual(decryptPatientDemographics(b.patientsById.get(did.patient.id)!).firstName, decryptPatientDemographics(did.patient).firstName);

    // The rebuilt runtime keeps working and keeps writing through.
    const next = b.offlineCardStore.issue(b.patientsById.get(did.patient.id)!);
    assert.strictEqual(next.card.version, 2);
    assert.strictEqual(store.refusedAudit(), 0);
    const c = await createRuntime(store);
    assert.strictEqual(c.offlineCardStore.getCurrentIssued(c.patientsById.get(did.patient.id)!)?.card.version, 2);
  });

  test('Nothing that is encrypted today, nor any health or contact data, is stored as plaintext', async () => {
    const store = recordingPersistence();
    const rt = await createRuntime(store);
    const did = await doEverything(rt);
    const demo = decryptPatientDemographics(did.patient);
    const plain = JSON.stringify(Object.fromEntries(Object.entries(store.tables).map(([k, v]) => [k, v instanceof Map ? [...v.values()] : v])));
    const banned = [demo.firstName, demo.lastName, demo.dateOfBirth, ...did.patient.emergencyContacts.flatMap((c) => [c.name, c.phone]),
      ...did.patient.allergies.map((a) => a.substance), ...did.patient.chronicConditions, ...did.patient.activeMedications.map((m) => m.medicationName),
      rt.codeByPatient.get(did.patient.id)!.formattedCode, rt.codeByPatient.get(did.patient.id)!.rawCode, did.card.token,
      'Synthetic follow-up reason', 'Synthetic break-glass detail', 'Synthetic second opinion', 'Synthetic scan detail',
      'Synthetic flag note', 'Synthetic dispute reason', 'One-time code'];
    for (const b of banned) assert.ok(!plain.includes(b), `stored rows must not contain ${String(b).slice(0, 30)}`);
  });

  test('A tampered stored audit chain stops the server from starting', async () => {
    const store = recordingPersistence();
    await createRuntime(store);
    store.tables.audit[3] = { ...store.tables.audit[3], action: 'TAMPERED' };
    await assert.rejects(createRuntime(store), /Stored audit chain does not verify/);
  });

  test('An audit entry that does not continue the stored chain is refused', async () => {
    const store = recordingPersistence();
    const rt = await createRuntime(store);
    const forged = { ...rt.auditManager.getEntries().at(-1)!, id: crypto.randomUUID() }; // same sequence number again
    store.appendAudit(forged);
    assert.strictEqual(store.refusedAudit(), 1);
  });
});
