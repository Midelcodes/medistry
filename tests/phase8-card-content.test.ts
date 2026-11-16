import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createPatientRecord, type PatientEntity } from '../src/lib/patient/profile.ts';
import {
  buildCardPayload,
  signCardWithSizeGuard,
  validateCardSelection,
  cardValidityDays,
  MAX_CARD_TOKEN_LENGTH,
  type CompactCardPayload,
} from '../src/lib/emergency/cardPayload.ts';
import { OfflineCardStore } from '../src/lib/emergency/offlineCardStore.ts';
import { verifyCompactJws, getPublicJwks, getKid } from '../src/lib/crypto/cardKeys.ts';
import { AuditChainManager } from '../src/lib/audit/hashChain.ts';
import { evaluatePolicy, type ActorContext } from '../src/lib/policy/enforcer.ts';
import { generateSeedData } from '../prisma/seed.ts';

const DX = { t: 'Synthetic recent diagnosis', d: '2026-10-01' };

function buildPatient(extra: Partial<Parameters<typeof createPatientRecord>[1]> = {}): PatientEntity {
  return createPatientRecord(
    { firstName: 'Test', lastName: 'Synthetic', dateOfBirth: '1990-01-01', gender: 'female' },
    {
      bloodGroup: 'B_POSITIVE',
      genotype: 'AS',
      allergies: [
        { substance: 'Penicillin', category: 'drug', reaction: 'Anaphylaxis', severity: 'severe' },
        { substance: 'Peanuts', category: 'food', reaction: 'Hives', severity: 'moderate' },
      ],
      chronicConditions: ['Condition Alpha', 'Condition Beta', 'Condition Gamma'],
      activeMedications: [
        { medicationName: 'Med One', dose: '10mg daily', route: 'oral', sinceDate: '2024-01-01' },
        { medicationName: 'Med Two', dose: '20mg daily', route: 'oral', sinceDate: '2024-02-01' },
        { medicationName: 'Med Three', dose: '30mg daily', route: 'oral', sinceDate: '2024-03-01' },
      ],
      emergencyContacts: [
        { id: 'c2', name: 'Second Contact', relationship: 'Friend', phone: '+234 800 000 0002', priority: 2 },
        { id: 'c1', name: 'Primary Contact', relationship: 'Sibling', phone: '+234 800 000 0001', priority: 1 },
      ],
      advanceDirectiveDnr: false,
      organDonor: true,
      ...extra,
    },
    { userId: 'u-synthetic', countryCode: 'NG' }
  );
}

const optIn = (p: PatientEntity, conds: string[], medNames: string[], dx: boolean) => {
  p.cardConditions = conds;
  p.cardMedicationIds = p.activeMedications.filter((m) => medNames.includes(m.medicationName)).map((m) => m.id);
  p.cardIncludeRecentDiagnosis = dx;
  return p;
};

describe('1. Card contents: core fields always, opt-in items only when chosen', () => {
  test('With no opt-ins, the payload contains no cond, med or dx', () => {
    const p = buildPatient();
    const payload = buildCardPayload(p, { cardVersion: 1, recentDiagnosis: DX, validityDays: 180 });
    assert.strictEqual(payload.e.cond, undefined);
    assert.strictEqual(payload.e.med, undefined);
    assert.strictEqual(payload.e.dx, undefined);

    // Core fields, compact keys, false flags omitted
    assert.deepStrictEqual(Object.keys(payload).sort(), ['c', 'cv', 'e', 'exp', 'iat', 'iss', 'sub', 'v']);
    assert.strictEqual(payload.iss, 'medistry');
    assert.strictEqual(payload.v, 1);
    assert.strictEqual(payload.c, 'NG');
    assert.strictEqual(payload.exp - payload.iat, 180 * 86400);
    assert.deepStrictEqual(payload.e, {
      bg: 'B+',
      gt: 'AS',
      alg: [{ s: 'Penicillin', r: 'Anaphylaxis' }], // severe only
      od: true,
      ec: { n: 'Primary Contact', p: '+234 800 000 0001' }, // lowest priority number
    });
    assert.strictEqual('dnr' in payload.e, false);
  });

  test('With opt-ins, the payload contains exactly the chosen items', () => {
    const p = optIn(buildPatient(), ['Condition Gamma', 'Condition Alpha'], ['Med Two'], true);
    const payload = buildCardPayload(p, { cardVersion: 3, recentDiagnosis: DX });
    assert.deepStrictEqual(payload.e.cond, ['Condition Alpha', 'Condition Gamma']); // record order
    assert.deepStrictEqual(payload.e.med, [{ n: 'Med Two', d: '20mg daily' }]);
    assert.deepStrictEqual(payload.e.dx, DX);
    assert.strictEqual(payload.cv, 3);

    p.cardIncludeRecentDiagnosis = false;
    assert.strictEqual(buildCardPayload(p, { cardVersion: 3, recentDiagnosis: DX }).e.dx, undefined);
  });

  test('Selections that are no longer on the record are never put on the card', () => {
    const p = optIn(buildPatient(), ['Condition Alpha'], ['Med One'], false);
    p.chronicConditions = ['Condition Beta'];
    p.activeMedications = p.activeMedications.slice(1);
    const payload = buildCardPayload(p, { cardVersion: 1 });
    assert.strictEqual(payload.e.cond, undefined);
    assert.strictEqual(payload.e.med, undefined);
  });

  test('Validity defaults to 180 days and follows OFFLINE_CARD_VALIDITY_DAYS', () => {
    assert.strictEqual(cardValidityDays({}), 180);
    assert.strictEqual(cardValidityDays({ OFFLINE_CARD_VALIDITY_DAYS: '90' }), 90);
    assert.strictEqual(cardValidityDays({ OFFLINE_CARD_VALIDITY_DAYS: 'nonsense' }), 180);
  });
});

describe('2. Selection validation: visibility only', () => {
  test('Choosing a medication id that is not on the patient is rejected', () => {
    const p = buildPatient();
    assert.throws(() => validateCardSelection(p, { cardMedicationIds: ['med-not-on-record'] }), /not on your record/);
    assert.throws(() => validateCardSelection(p, { cardConditions: ['Invented Condition'] }), /not on your record/);
    assert.throws(() => validateCardSelection(p, { cardIncludeRecentDiagnosis: 'yes' }), /true or false/);
    assert.throws(() => validateCardSelection(p, { cardConditions: 'Condition Alpha' }), /list of strings/);

    const ok = validateCardSelection(p, { cardMedicationIds: [p.activeMedications[0].id, p.activeMedications[0].id] });
    assert.deepStrictEqual(ok.cardMedicationIds, [p.activeMedications[0].id], 'duplicates collapse');
  });

  test('Medication ids are stable for the same seeded data', () => {
    const a = generateSeedData().patients[0].patient.activeMedications.map((m) => m.id);
    const b = generateSeedData().patients[0].patient.activeMedications.map((m) => m.id);
    assert.deepStrictEqual(a, b);
    assert.strictEqual(new Set(a).size, a.length);
  });

  test('Seed gives 1 to 2 synthetic patients opt-ins that exist on their records', () => {
    const withOptIns = generateSeedData().patients.map((s) => s.patient)
      .filter((p) => p.cardConditions.length || p.cardMedicationIds.length || p.cardIncludeRecentDiagnosis);
    assert.ok(withOptIns.length >= 1 && withOptIns.length <= 2);
    for (const p of withOptIns) {
      assert.doesNotThrow(() => validateCardSelection(p, { cardConditions: p.cardConditions, cardMedicationIds: p.cardMedicationIds }));
      assert.ok(p.cardMedicationIds.length > 0);
    }
  });
});

describe('3. Size guard', () => {
  const corePart = (p: CompactCardPayload) => ({ bg: p.e.bg, gt: p.e.gt, alg: p.e.alg, dnr: p.e.dnr, od: p.e.od, ec: p.e.ec });

  test('Drops dx, then med from the end, then cond from the end, and never core fields', () => {
    const p = optIn(buildPatient(), ['Condition Alpha', 'Condition Beta', 'Condition Gamma'], ['Med One', 'Med Two', 'Med Three'], true);
    const full = buildCardPayload(p, { cardVersion: 1, recentDiagnosis: DX });

    const everything = signCardWithSizeGuard(full, { maxLength: 1 });
    assert.deepStrictEqual(everything.warnings.slice(0, 7).map((w) => w.split(' "')[0] + ' ' + w.split('"')[1]), [
      'Dropped recent diagnosis Synthetic recent diagnosis',
      'Dropped medication Med Three',
      'Dropped medication Med Two',
      'Dropped medication Med One',
      'Dropped condition Condition Gamma',
      'Dropped condition Condition Beta',
      'Dropped condition Condition Alpha',
    ]);
    assert.match(everything.warnings[7], /Core emergency data alone/);
    assert.strictEqual(everything.warnings.length, 8);
    assert.deepStrictEqual(corePart(everything.payload), corePart(full));
    assert.strictEqual(everything.payload.e.cond, undefined);
    assert.strictEqual(everything.payload.e.med, undefined);
    assert.strictEqual(everything.payload.e.dx, undefined);
    assert.deepStrictEqual(full.e.med?.length, 3, 'input payload is not mutated');

    // Limit that fits once dx and the last medication are gone: only those two are dropped.
    const target = structuredClone(full);
    delete target.e.dx;
    target.e.med!.pop();
    const limit = signCardWithSizeGuard(target, { maxLength: 1e9 }).token.length;
    const partial = signCardWithSizeGuard(full, { maxLength: limit });
    assert.strictEqual(partial.warnings.length, 2);
    assert.deepStrictEqual(partial.payload.e.med, [{ n: 'Med One', d: '10mg daily' }, { n: 'Med Two', d: '20mg daily' }]);
    assert.strictEqual(partial.payload.e.cond?.length, 3);
    assert.ok(partial.token.length <= limit);
  });

  test('With the default 1800-character limit, long opt-ins are trimmed and core stays', () => {
    const long = (label: string) => `${label} ${'x'.repeat(180)}`;
    const conds = Array.from({ length: 6 }, (_, i) => long(`Condition ${i}`));
    const p = buildPatient({ chronicConditions: conds });
    p.cardConditions = conds;
    const result = signCardWithSizeGuard(buildCardPayload(p, { cardVersion: 1 }));
    assert.strictEqual(MAX_CARD_TOKEN_LENGTH, 1800);
    assert.ok(result.token.length <= 1800, `token is ${result.token.length} chars`);
    assert.ok(result.warnings.length > 0);
    assert.strictEqual(result.payload.e.bg, 'B+');
    assert.deepStrictEqual(result.payload.e.alg, [{ s: 'Penicillin', r: 'Anaphylaxis' }]);
    assert.ok(verifyCompactJws(result.token, getPublicJwks()).valid);
  });
});

describe('4. Card issuance and versioning', () => {
  test('Reissuing increments cv and supersedes the previous card', () => {
    const audit = new AuditChainManager();
    const store = new OfflineCardStore(audit);
    const p = optIn(buildPatient(), ['Condition Alpha'], ['Med One'], false);
    assert.strictEqual(p.cardVersion, 0);

    const first = store.issue(p);
    assert.strictEqual(first.card.version, 1);
    assert.strictEqual(first.payload.cv, 1);
    assert.strictEqual(p.cardVersion, 1);
    assert.strictEqual(first.card.kid, getKid());
    assert.strictEqual(first.card.payloadHash, crypto.createHash('sha256').update(first.token).digest('hex'));
    assert.strictEqual(new Date(first.card.expiresAt).getTime() - new Date(first.card.issuedAt).getTime(), 180 * 86400 * 1000);

    const second = store.issue(p);
    assert.strictEqual(second.card.version, 2);
    assert.strictEqual(second.payload.cv, 2);
    assert.strictEqual(p.cardVersion, 2);

    const rows = store.list(p.id);
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].supersededById, second.card.id);
    assert.strictEqual(rows[1].supersededById, undefined);
    assert.strictEqual(store.getCurrent(p.id)?.id, second.card.id);
    assert.ok(verifyCompactJws(second.token, getPublicJwks()).valid);

    const issued = audit.getEntries().filter((e) => e.action === 'OFFLINE_CARD_ISSUED');
    assert.strictEqual(issued.length, 2);
    assert.ok(issued.every((e) => !e.reason?.includes('Condition Alpha') && !e.reason?.includes('Med One')), 'no card content in audit');
    assert.strictEqual(audit.verifyChain().valid, true);
  });
});

describe('5. Access policy regression', () => {
  const patient: ActorContext = { userId: 'patient-1', role: 'PATIENT' };

  test('The enforcer still denies PATIENT_WRITE_RECORD to patients, even on their own record', () => {
    const own = evaluatePolicy({ actor: patient, action: 'PATIENT_WRITE_RECORD', targetPatientId: 'patient-1' });
    assert.strictEqual(own.allowed, false);
    assert.strictEqual(own.statusCode, 403);
    assert.strictEqual(evaluatePolicy({ actor: patient, action: 'PATIENT_WRITE_RECORD', targetPatientId: 'patient-2' }).allowed, false);
  });

  test('Card visibility is allowed only for the patient\'s own record and is not a clinical write', () => {
    assert.strictEqual(evaluatePolicy({ actor: patient, action: 'PATIENT_SET_CARD_VISIBILITY', targetPatientId: 'patient-1' }).allowed, true);
    assert.strictEqual(evaluatePolicy({ actor: patient, action: 'PATIENT_SET_CARD_VISIBILITY', targetPatientId: 'patient-2' }).allowed, false);
    const doctor: ActorContext = { userId: 'u-doc', role: 'DOCTOR', clinicianId: 'c-doc', isVerifiedClinician: true };
    assert.strictEqual(evaluatePolicy({ actor: doctor, action: 'PATIENT_SET_CARD_VISIBILITY', targetPatientId: 'patient-1' }).allowed, false);
  });
});

describe('6. Patient portal API (end to end, demo mode)', () => {
  const PORT = 36000 + Math.floor(Math.random() * 2000);
  const base = `http://localhost:${PORT}`;
  let server: ChildProcess;
  let patientId = '';
  let medIds: string[] = [];
  let conditions: string[] = [];

  before(async () => {
    server = spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], { env: { ...process.env, STORAGE: 'memory', PORT: String(PORT) }, stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    // Seed patient 2 has conditions and medications but no card opt-ins.
    const { patients } = await (await fetch(`${base}/api/patients`)).json();
    patientId = patients[1].id;
    const { patient } = await (await fetch(`${base}/api/patients/${patientId}`)).json();
    medIds = patient.activeMedications.map((m: { id: string }) => m.id);
    conditions = patient.chronicConditions;
  });
  after(() => { server?.kill(); });

  const patch = (body: unknown) => fetch(`${base}/api/patients/${patientId}/settings`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  test('PATCH settings rejects unknown items and any clinical field', async () => {
    assert.strictEqual((await patch({ cardMedicationIds: ['med-not-on-record'] })).status, 400);
    assert.strictEqual((await patch({ cardConditions: ['Invented Condition'] })).status, 400);
    const clinical = await patch({ chronicConditions: ['Invented Condition'] });
    assert.strictEqual(clinical.status, 400);
    assert.match((await clinical.json()).error, /Only visibility settings/);
    assert.strictEqual((await patch({})).status, 400);
  });

  test('PATCH settings saves the selection; issuing twice gives cv 1 then 2 with the chosen items only', async () => {
    const res = await patch({ cardConditions: [conditions[0]], cardMedicationIds: [medIds[0]], cardIncludeRecentDiagnosis: true });
    assert.strictEqual(res.status, 200);
    const { patient } = await res.json();
    assert.deepStrictEqual(patient.card, { conditions: [conditions[0]], medicationIds: [medIds[0]], includeRecentDiagnosis: true, version: 0, stale: false });

    const first = await (await fetch(`${base}/api/patients/${patientId}/offline-card`, { method: 'POST' })).json();
    const second = await (await fetch(`${base}/api/patients/${patientId}/offline-card`, { method: 'POST' })).json();
    assert.strictEqual(first.cardVersion, 1);
    assert.strictEqual(second.cardVersion, 2);
    assert.deepStrictEqual(second.payload.e.cond, [conditions[0]]);
    assert.strictEqual(second.payload.e.med.length, 1);
    assert.ok(second.payload.e.dx?.t, 'recent diagnosis included when opted in');
    assert.deepStrictEqual(second.warnings, []);

    const { keys } = await (await fetch(`${base}/.well-known/medistry-keys.json`)).json();
    assert.strictEqual(verifyCompactJws(second.token, keys).valid, true);

    const { cards } = await (await fetch(`${base}/api/patients/${patientId}/offline-cards`)).json();
    assert.strictEqual(cards.length, 2);
    assert.ok(cards[0].supersededById);
    assert.strictEqual('token' in cards[0], false, 'tokens are not stored');
  });
});
