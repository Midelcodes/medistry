import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  ClinicianVerificationManager,
  COUNTRY_REGISTRIES,
  GENERIC_LICENCE_FORMAT,
  validateLicenceFormat,
  validateMdcnLicenseFormat,
  ManualKmpdcRegistryAdapter,
} from '../src/lib/clinician/verification.ts';
import { generateSeedData } from '../prisma/seed.ts';
import { deploymentCountry } from '../src/lib/security/config.ts';
import { createPatientRecord, type PatientEntity } from '../src/lib/patient/profile.ts';
import { buildCardPayload } from '../src/lib/emergency/cardPayload.ts';
import { AuditChainManager } from '../src/lib/audit/hashChain.ts';
import { NotificationDispatcher, ConsoleNotificationProvider } from '../src/lib/notifications/dispatcher.ts';
import { OfflineCardStore } from '../src/lib/emergency/offlineCardStore.ts';
import { OfflineScanService } from '../src/lib/emergency/offlineScans.ts';
import { buildOfflineCardBundle } from '../src/lib/emergency/offlineCard.ts';
import { auditHtmlForWcag21AA } from '../src/lib/security/accessibilityAudit.ts';
import { TRANSLATIONS } from '../src/lib/i18n/translations.ts';
import { signScanEvent } from '../site/js/lib/offlineScan.js';

const submission = (over: Record<string, unknown>) => ({
  id: 'c-test', userId: 'u-test', fullName: 'Dr. Synthetic Test', specialty: 'Emergency Medicine', licenseNumber: '', ...over,
});

describe('1. Nigeria (MDCN) is unchanged', () => {
  test('NG validation and onboarding messages behave exactly as before', async () => {
    for (const l of ['MDCN/R/10294', 'mdcn/r/48201', 'INVALID-1234', 'MDCN/X/12345', '']) {
      assert.deepStrictEqual(validateLicenceFormat('NG', l), validateMdcnLicenseFormat(l), l);
      assert.deepStrictEqual(validateLicenceFormat(undefined, l), validateMdcnLicenseFormat(l), `${l} (no country = NG)`);
    }
    const m = new ClinicianVerificationManager();
    const known = await m.processOnboardingSubmission(submission({ licenseNumber: 'MDCN/R/10294' }));
    assert.strictEqual(known.message, 'MDCN license recognized in registry. Pending final Platform Admin sign-off.');
    assert.strictEqual(known.profile.countryCode, 'NG');
    assert.strictEqual(known.profile.status, 'PENDING');
    const unknown = await m.processOnboardingSubmission(submission({ licenseNumber: 'MDCN/R/99999', countryCode: 'NG' }));
    assert.strictEqual(unknown.message, 'License submitted. Queued for manual MDCN registrar review.');
    assert.strictEqual(COUNTRY_REGISTRIES.NG.regulatorName, 'Medical and Dental Council of Nigeria (MDCN)');
  });
});

describe('2. Kenya (KMPDC), manual and format not confirmed', () => {
  test('KE has no invented licence format: only the generic check applies, verification is manual', () => {
    assert.strictEqual(COUNTRY_REGISTRIES.KE.regulatorName, 'Kenya Medical Practitioners and Dentists Council (KMPDC)');
    assert.strictEqual(COUNTRY_REGISTRIES.KE.licenceFormat, null);
    assert.strictEqual(COUNTRY_REGISTRIES.KE.verificationMode, 'manual');
    assert.ok(COUNTRY_REGISTRIES.KE.adapter instanceof ManualKmpdcRegistryAdapter);
    assert.strictEqual(GENERIC_LICENCE_FORMAT.source, '^[A-Za-z0-9/-]{3,20}$');
  });

  test('A KE clinician with a demo licence verifies through the manual adapter', async () => {
    const m = new ClinicianVerificationManager();
    const r = await m.processOnboardingSubmission(submission({ countryCode: 'ke', licenseNumber: '  demo-ke-1001 ' }));
    assert.strictEqual(r.profile.countryCode, 'KE');
    assert.strictEqual(r.profile.licenseNumber, 'DEMO-KE-1001');
    assert.strictEqual(r.registryMatch, true);
    assert.strictEqual(r.verificationMode, 'manual');
    assert.strictEqual(r.regulator, 'Kenya Medical Practitioners and Dentists Council (KMPDC)');
    assert.match(r.message, /KMPDC licence found in the demo list\. Pending manual review/);
    assert.strictEqual(m.approveVerification(r.profile, 'platform-admin-1').status, 'VERIFIED');

    const notListed = await m.processOnboardingSubmission(submission({ countryCode: 'KE', licenseNumber: 'A1/2345-B' }));
    assert.strictEqual(notListed.registryMatch, false);
    assert.strictEqual(notListed.message, 'Licence submitted. Queued for manual KMPDC review.');
  });

  test('An empty or malformed KE licence is rejected', async () => {
    const m = new ClinicianVerificationManager();
    for (const bad of ['', '   ', 'AB', 'X'.repeat(21), 'BAD LICENCE', 'DEMO_KE_1', '<script>', 'KE#123']) {
      await assert.rejects(m.processOnboardingSubmission(submission({ countryCode: 'KE', licenseNumber: bad })), /License number is required|Invalid KMPDC licence/, JSON.stringify(bad));
    }
    await assert.rejects(m.processOnboardingSubmission(submission({ countryCode: 'GH', licenseNumber: 'ABC123' })), /not supported yet/);
  });
});

describe('3. Seed data and deployment country', () => {
  test('Two synthetic Nairobi facilities and three synthetic Kenyan clinicians, clearly marked', async () => {
    const seed = generateSeedData();
    const ke = seed.facilities.filter((f) => f.countryCode === 'KE');
    assert.strictEqual(ke.length, 2);
    for (const f of ke) {
      assert.strictEqual(f.region, 'Nairobi');
      assert.strictEqual(f.synthetic, true);
      assert.match(f.name, /Synthetic .*not a real facility/);
      assert.match(f.registryCode || '', /^DEMO-KMFL-\d{4}$/);
    }
    assert.ok(seed.facilities.filter((f) => f.countryCode === 'NG').every((f) => f.registryCode === null), 'no invented Nigerian registry codes');
    const keClinicians = seed.clinicians.filter((c) => c.countryCode === 'KE');
    assert.strictEqual(keClinicians.length, 3);
    const adapter = new ManualKmpdcRegistryAdapter();
    for (const c of keClinicians) {
      assert.match(c.licenseNumber, /^DEMO-/);
      assert.match(c.fullName, /Synthetic .*\(demo\)/);
      assert.ok(ke.some((f) => f.id === c.facilityId));
      assert.strictEqual((await adapter.queryRegistry(c.licenseNumber)).found, true);
    }
    assert.ok(seed.clinicians.filter((c) => c.countryCode === 'NG').every((c) => validateMdcnLicenseFormat(c.licenseNumber).valid));
  });

  test('DEPLOYMENT_COUNTRY sets the default country of new patients, records and cards', () => {
    assert.strictEqual(deploymentCountry({}), 'NG');
    assert.strictEqual(deploymentCountry({ DEPLOYMENT_COUNTRY: ' ke ' }), 'KE');
    assert.strictEqual(deploymentCountry({ DEPLOYMENT_COUNTRY: 'Kenya' }), 'NG');
    const saved = process.env.DEPLOYMENT_COUNTRY;
    process.env.DEPLOYMENT_COUNTRY = 'KE';
    try {
      const p = createPatientRecord({ firstName: 'Test', lastName: 'Synthetic', dateOfBirth: '1990-01-01', gender: 'male' }, { bloodGroup: 'O_POSITIVE', genotype: 'AA' }, { userId: 'u' });
      assert.strictEqual(p.countryCode, 'KE');
      assert.strictEqual(buildCardPayload(p, { cardVersion: 1 }).c, 'KE');
      const explicit = createPatientRecord({ firstName: 'T', lastName: 'S', dateOfBirth: '1990-01-01', gender: 'male' }, { bloodGroup: 'O_POSITIVE', genotype: 'AA' }, { userId: 'u', countryCode: 'NG' });
      assert.strictEqual(explicit.countryCode, 'NG');
    } finally {
      if (saved === undefined) delete process.env.DEPLOYMENT_COUNTRY; else process.env.DEPLOYMENT_COUNTRY = saved;
    }
  });
});

describe('4. Cross-border offline scans', () => {
  function setup() {
    const seed = generateSeedData();
    const patientsById = new Map<string, PatientEntity>(seed.patients.map((p) => [p.patient.id, p.patient]));
    const auditManager = new AuditChainManager();
    const provider = new ConsoleNotificationProvider();
    const svc = new OfflineScanService({
      auditManager, dispatcher: new NotificationDispatcher(provider), cardStore: new OfflineCardStore(auditManager),
      clinicians: seed.clinicians, facilities: seed.facilities, patientsById,
    });
    return { seed, svc, auditManager, provider };
  }
  async function scan(svc: OfflineScanService, clinicianId: string, patient: PatientEntity) {
    const kp = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair;
    const dk = svc.bindDeviceKey(clinicianId, await globalThis.crypto.subtle.exportKey('jwk', kp.publicKey));
    const { pass } = svc.issuePass(clinicianId, dk);
    const ev = await signScanEvent({ eventId: crypto.randomUUID(), cardSub: patient.id, cardVersion: 1, cardKid: 'kid', reason: 'UNCONSCIOUS', scannedAt: new Date().toISOString(), pass }, kp.privateKey);
    return { ev, pass, result: svc.processBatch([ev], { ipAddress: '127.0.0.1', userAgent: 'test' })[0] };
  }

  test('A Kenyan clinician can upload an offline scan for a Nigerian card, and the event records both countries', async () => {
    const { seed, svc, auditManager, provider } = setup();
    const kenyan = seed.clinicians.find((c) => c.countryCode === 'KE')!;
    const nigerian = seed.patients[0].patient;
    assert.strictEqual(nigerian.countryCode, 'NG');

    const { ev, pass, result } = await scan(svc, kenyan.id, nigerian);
    assert.strictEqual(JSON.parse(Buffer.from(pass.split('.')[1], 'base64url').toString()).country, 'KE');
    assert.strictEqual(result.status, 'accepted', result.reason);
    const stored = svc.getEvent(ev.eventId)!;
    assert.strictEqual(stored.clinicianCountry, 'KE');
    assert.strictEqual(stored.cardCountry, 'NG');
    assert.strictEqual(stored.facilityId, kenyan.facilityId);

    const audit = auditManager.getEntries().find((e) => e.action === 'OFFLINE_EMERGENCY_SCAN')!;
    assert.match(audit.reason || '', /cross-border: clinician KE, card NG/);
    assert.match(audit.reason || '', /Synthetic Demo Hospital Nairobi/);
    assert.strictEqual(audit.countryCode, 'NG');
    assert.strictEqual(auditManager.verifyChain().valid, true);
    assert.match(provider.sentPushLogs.at(-1)!.body, /scanned by Dr\. Synthetic .* \(demo\) at Synthetic Demo Hospital Nairobi/);
  });

  test('A same-country scan is not marked cross-border; notifications follow the patient language', async () => {
    const { seed, svc, auditManager, provider } = setup();
    const patient = seed.patients[1].patient;
    patient.preferredLocale = 'sw';
    const ng = seed.clinicians.find((c) => c.countryCode === 'NG')!;
    const { ev } = await scan(svc, ng.id, patient);
    assert.deepStrictEqual([svc.getEvent(ev.eventId)!.clinicianCountry, svc.getEvent(ev.eventId)!.cardCountry], ['NG', 'NG']);
    assert.ok(!auditManager.getEntries().at(-1)!.reason?.includes('cross-border'));
    const push = provider.sentPushLogs.at(-1)!;
    assert.strictEqual(push.title, 'Kadi ya dharura imechanganuliwa');
    assert.match(push.body, /^Kadi yako ya dharura ilichanganuliwa na .* kwa sababu: mgonjwa amepoteza fahamu\./);
  });
});

describe('5. Swahili for user-facing strings from Phases 3 to 6', () => {
  test('Every card, notification and scanner string has a Swahili translation', () => {
    const keys = Object.keys(TRANSLATIONS.en).filter((k) => /^(card_|notify_|scan_)/.test(k));
    assert.ok(keys.length >= 90, `${keys.length} keys`);
    for (const k of keys) assert.ok(TRANSLATIONS.sw[k], `sw missing ${k}`);
  });

  test('The printed card renders in Swahili and still passes the accessibility audit', async () => {
    const seed = generateSeedData();
    const issued = new OfflineCardStore().issue(seed.patients[1].patient);
    const sw = await buildOfflineCardBundle(issued, { baseUrl: 'https://demo.example', formattedCode: seed.patients[1].emergencyCode.formattedCode, locale: 'sw' });
    for (const s of ['<html lang="sw">', 'KADI YA MATIBABU YA DHARURA', 'Kundi la damu', 'Mzio mkali', 'DNR IMEANDIKWA', 'Chapisha kadi']) assert.ok(sw.cardHtml.includes(s), s);
    assert.strictEqual(auditHtmlForWcag21AA(sw.cardHtml).passed, true);
    const en = await buildOfflineCardBundle(issued, { baseUrl: 'https://demo.example', formattedCode: seed.patients[1].emergencyCode.formattedCode });
    assert.ok(en.cardHtml.includes('EMERGENCY MEDICAL CARD'));
    assert.strictEqual(en.token, sw.token, 'same signed card; only the printed text changes');
  });
});

describe('6. Server under DEPLOYMENT_COUNTRY=KE', () => {
  const PORT = 41000 + Math.floor(Math.random() * 1000);
  const base = `http://localhost:${PORT}`;
  let server: ChildProcess;
  before(async () => {
    server = spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], { env: { ...process.env, PORT: String(PORT), DEPLOYMENT_COUNTRY: 'KE' }, stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('server did not start');
  });
  after(() => { server?.kill(); });

  test('Health reports the deployment country and its regulator; patients can choose Swahili for card and alerts', async () => {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.strictEqual(health.countryCode, 'KE');
    assert.strictEqual(health.regulator, 'Kenya Medical Practitioners and Dentists Council (KMPDC)');

    const { patients } = await (await fetch(`${base}/api/patients`)).json();
    const id = patients[0].id;
    const patch = (body: unknown) => fetch(`${base}/api/patients/${id}/settings`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.strictEqual((await patch({ preferredLocale: 'xx' })).status, 400);
    assert.strictEqual((await patch({ preferredLocale: 'sw' })).status, 200);
    const card = await (await fetch(`${base}/api/patients/${id}/offline-card`)).json();
    assert.strictEqual(card.locale, 'sw');
    assert.ok(card.cardHtml.includes('KADI YA MATIBABU YA DHARURA'));
    const english = await (await fetch(`${base}/api/patients/${id}/offline-card?lang=en`)).json();
    assert.ok(english.cardHtml.includes('EMERGENCY MEDICAL CARD'));
    assert.strictEqual(english.cardVersion, card.cardVersion, 'changing language does not reissue the card');
    const { clinicians } = await (await fetch(`${base}/api/clinicians`)).json();
    assert.strictEqual(clinicians.filter((c: { countryCode: string }) => c.countryCode === 'KE').length, 3);
  });
});
