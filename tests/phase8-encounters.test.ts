import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { generateSeedData, type SeedClinician } from '../prisma/seed.ts';
import { AuditChainManager } from '../src/lib/audit/hashChain.ts';
import { ClinicalDataStore } from '../src/lib/clinical/store.ts';
import { ClinicalTimelineEngine } from '../src/lib/clinical/timeline.ts';
import { NotificationDispatcher, ConsoleNotificationProvider } from '../src/lib/notifications/dispatcher.ts';
import { EmergencyBreakGlassEngine } from '../src/lib/emergency/breakGlassEngine.ts';
import { renderEmergencySummaryHtml } from '../src/lib/emergency/summaryRenderer.ts';
import { OfflineCardStore } from '../src/lib/emergency/offlineCardStore.ts';
import { CardContentSync } from '../src/lib/emergency/cardSync.ts';
import { seedClinicalRecords } from '../src/lib/site/seedClinical.ts';
import { recentEncounters, latestDiagnosisForCard, NOT_RECORDED } from '../src/lib/clinical/encounters.ts';
import { createPatientRecord, type PatientEntity } from '../src/lib/patient/profile.ts';
import type { ActorContext, ConsentContext } from '../src/lib/policy/enforcer.ts';

/** Same wiring as src/server.ts, including the seeded encounters. */
function setup() {
  const seed = generateSeedData();
  const patientsById = new Map<string, PatientEntity>(seed.patients.map((p) => [p.patient.id, p.patient]));
  const auditManager = new AuditChainManager();
  const store = new ClinicalDataStore(auditManager);
  const dispatcher = new NotificationDispatcher(new ConsoleNotificationProvider());
  seedClinicalRecords(store, seed.patients.map((p) => p.patient), seed.clinicians, seed.facilities,
    new Map(seed.patients.map((p) => [p.patient.id, p.encounters])));
  const sync = new CardContentSync({ patientsById, dispatcher, auditManager });
  store.onFinalRecord((e) => sync.handle(e));
  const engine = new EmergencyBreakGlassEngine(auditManager, store, new ClinicalTimelineEngine(store), dispatcher);
  return { seed, store, engine, patientsById };
}

const doctorActor = (c: SeedClinician): ActorContext => ({ userId: c.userId, role: 'DOCTOR', clinicianId: c.id, facilityId: c.facilityId, isVerifiedClinician: true });
const consentFor = (patientId: string, facilityId: string, clinicianId?: string): ConsentContext => ({
  id: `c-${crypto.randomUUID()}`, patientId, targetFacilityId: facilityId, targetClinicianId: clinicianId, scopes: ['all'], validUntil: new Date(Date.now() + 86_400_000), isRevoked: false,
});

async function summaryFor(engine: EmergencyBreakGlassEngine, patient: PatientEntity, doctor: SeedClinician) {
  const { grant } = await engine.initiateBreakGlass({
    patient, emergencyCode: 'K7QM-4T9X-2HDP-8W2', actor: doctorActor(doctor), treatingDoctorName: doctor.fullName,
    facilityId: doctor.facilityId, facilityName: 'Synthetic ER', reason: 'UNCONSCIOUS',
  });
  return engine.buildEmergencySummary(patient, grant.id);
}

function encounter(patient: PatientEntity, clin: SeedClinician, facilityName: string, daysAgo: number, extra: Record<string, unknown> = {}) {
  const when = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  return {
    resourceType: 'Encounter', id: crypto.randomUUID(), status: 'finished',
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'EMER', display: 'Emergency' },
    subject: { reference: `Patient/${patient.id}` },
    participant: [{ individual: { reference: `Practitioner/${clin.id}`, display: clin.fullName } }],
    period: { start: when }, effectiveDateTime: when,
    serviceProvider: { reference: `Organization/${clin.facilityId}`, display: facilityName },
    ...extra,
  } as any;
}

describe('Recent encounters come from signed records', () => {
  test('Two different seeded patients return different recent encounters, newest first, with real fields', async () => {
    const { seed, engine } = setup();
    const [amara, babajide] = [seed.patients[0].patient, seed.patients[1].patient];
    const doctor = seed.clinicians[0];
    const a = (await summaryFor(engine, amara, doctor)).recentEncounters;
    const b = (await summaryFor(engine, babajide, doctor)).recentEncounters;

    assert.deepStrictEqual(a.map((e) => e.diagnosis), ['Vaso-occlusive crisis', 'Sickle cell anaemia (HbSS), stable']);
    assert.deepStrictEqual(b.map((e) => e.diagnosis), ['Acute asthma exacerbation', 'Severe persistent asthma']);
    assert.notDeepStrictEqual(a, b);
    assert.ok(a[0].date > a[1].date, 'newest first');
    assert.deepStrictEqual(Object.keys(a[0]).sort(), ['date', 'diagnosis', 'doctorName', 'facilityName', 'result', 'treatment']);
    assert.strictEqual(a[0].treatment, 'IV fluids and analgesia');
    assert.strictEqual(a[0].result, 'Discharged home after 3 days');
    assert.strictEqual(a[0].facilityName, 'Lagos University Teaching Hospital (LUTH)');
    assert.ok(seed.clinicians.some((c) => c.fullName === a[0].doctorName));
    for (const p of seed.patients) {
      const list = (await summaryFor(engine, p.patient, doctor)).recentEncounters;
      assert.strictEqual(list.length, p.encounters.length, 'every seeded encounter is returned');
      assert.ok(list.every((e) => e.diagnosis !== NOT_RECORDED && e.treatment !== NOT_RECORDED && e.result !== NOT_RECORDED));
    }
  });

  test('A patient with zero encounters returns [] and the summary says "No encounters on record"', async () => {
    const { seed, engine } = setup();
    const lonely = createPatientRecord({ firstName: 'Test', lastName: 'Synthetic', dateOfBirth: '1990-01-01', gender: 'female' }, { bloodGroup: 'O_POSITIVE', genotype: 'AA' }, { userId: 'u-none' });
    const summary = await summaryFor(engine, lonely, seed.clinicians[0]);
    assert.deepStrictEqual(summary.recentEncounters, []);
    const html = renderEmergencySummaryHtml(summary);
    assert.ok(html.includes('No encounters on record'));
    // Nothing assumed: no pregnancy status or implants are invented
    assert.strictEqual(summary.chronicCare.pregnancyStatus, undefined);
    assert.strictEqual(summary.chronicCare.implantsOrDevices, undefined);
    assert.ok(!html.includes('Non-pregnant'));
    assert.ok(!html.includes('None on record'));
  });

  test('Missing fields read "Not recorded"; drafts never appear; at most 5, newest first', async () => {
    const { seed, store, engine } = setup();
    const patient = seed.patients[4].patient; // one seeded encounter
    const doctor = seed.clinicians.find((c) => c.facilityId === patient.primaryFacilityId)!;
    const facility = seed.facilities.find((f) => f.id === doctor.facilityId)!.name;
    store.writeRecord(patient.id, encounter(patient, doctor, facility, 1), doctorActor(doctor), { consent: consentFor(patient.id, doctor.facilityId, doctor.id), facilityId: doctor.facilityId });
    store.writeRecord(patient.id, encounter(patient, doctor, facility, 0, { diagnosis: [{ condition: { reference: 'Condition/x', display: 'Synthetic draft diagnosis' } }] }),
      { userId: 'u-nurse', role: 'NURSE', facilityId: doctor.facilityId, isVerifiedStaff: true }, { consent: consentFor(patient.id, doctor.facilityId), facilityId: doctor.facilityId });

    const list = (await summaryFor(engine, patient, doctor)).recentEncounters;
    assert.strictEqual(list.length, 2, 'the nurse draft is not included');
    assert.deepStrictEqual([list[0].diagnosis, list[0].treatment, list[0].result], [NOT_RECORDED, NOT_RECORDED, NOT_RECORDED]);
    assert.strictEqual(list[0].doctorName, doctor.fullName);
    assert.strictEqual(latestDiagnosisForCard(store, patient.id), null, 'newest encounter has no diagnosis, so no dx on the card');

    for (let i = 2; i < 9; i++) {
      store.writeRecord(patient.id, encounter(patient, doctor, facility, 100 + i), doctorActor(doctor), { consent: consentFor(patient.id, doctor.facilityId, doctor.id), facilityId: doctor.facilityId });
    }
    assert.strictEqual(recentEncounters(store, patient.id).length, 5);
    assert.strictEqual(recentEncounters(store, patient.id, 50).length, 9);
  });
});

describe('Card and summary agree', () => {
  test('The card dx equals the newest encounter diagnosis when opted in', async () => {
    const { seed, store, engine } = setup();
    const khadijah = seed.patients[8].patient; // opted in to the recent diagnosis
    assert.strictEqual(khadijah.cardIncludeRecentDiagnosis, true);
    const doctor = seed.clinicians.find((c) => c.facilityId === khadijah.primaryFacilityId)!;
    const summary = await summaryFor(engine, khadijah, doctor);
    const cards = new OfflineCardStore();
    const issued = cards.issue(khadijah, { recentDiagnosis: latestDiagnosisForCard(store, khadijah.id) });
    assert.deepStrictEqual(issued.payload.e.dx, { t: summary.recentEncounters[0].diagnosis, d: summary.recentEncounters[0].date });
    assert.strictEqual(issued.payload.e.dx?.t, 'Acute decompensated heart failure');

    // A newly signed encounter becomes both the summary's first row and the card's dx, and marks the card stale
    const facility = seed.facilities.find((f) => f.id === doctor.facilityId)!.name;
    store.writeRecord(khadijah.id, encounter(khadijah, doctor, facility, 0, {
      diagnosis: [{ condition: { reference: 'Condition/y', display: 'Synthetic new diagnosis' }, rank: 1 }],
    }), doctorActor(doctor), { consent: consentFor(khadijah.id, doctor.facilityId, doctor.id), facilityId: doctor.facilityId });
    assert.strictEqual(khadijah.cardStale, true);
    const after = await summaryFor(engine, khadijah, doctor);
    assert.strictEqual(after.recentEncounters[0].diagnosis, 'Synthetic new diagnosis');
    assert.strictEqual(latestDiagnosisForCard(store, khadijah.id)?.t, 'Synthetic new diagnosis');

    // Not opted in: no dx on the card even though the summary has one
    const amara = seed.patients[0].patient;
    assert.strictEqual(amara.cardIncludeRecentDiagnosis, false);
    assert.strictEqual(cards.issue(amara, { recentDiagnosis: latestDiagnosisForCard(store, amara.id) }).payload.e.dx, undefined);
  });
});

describe('Codebase clean-up', () => {
  test('Neither the old mock-encounter marker nor the old issuer string remains in any tracked file', () => {
    const banned = ['Mock last 5 ' + 'encounters', 'REGIONAL_' + 'HEALTH_AUTHORITY'];
    const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter((f) => f && !/\.(png|ico|jpg|svg)$/.test(f));
    const hits: string[] = [];
    for (const f of files) {
      let text = '';
      try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
      for (const b of banned) if (text.includes(b)) hits.push(`${f}: ${b}`);
    }
    assert.deepStrictEqual(hits, []);
  });
});
