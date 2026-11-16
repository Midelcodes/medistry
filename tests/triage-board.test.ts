// Triage board: the triage agent's results (decision support) reach the clinician console, sorted by urgency,
// with deterioration, referral acceptance (audited) and, for the patient, only where they were referred.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRuntime } from '../src/lib/runtime.ts';
import { createMemoryPersistence } from '../src/lib/data/memory/persistence.ts';
import { createPortalApi } from '../src/lib/site/portalApi.ts';
import { generateTotp } from '../src/lib/auth/security.ts';
import { parseTriagePayload, TriageValidationError } from '../src/lib/emergency/triageBoard.ts';

const rt = await createRuntime(createMemoryPersistence());
const api = createPortalApi({ ...rt, notifications: rt.consoleProvider, offlineCards: rt.offlineCardStore, dataDir: path.join(os.tmpdir(), 'medistry-triage-board') });
let base = '';
const server = http.createServer(async (req, res) => {
  if (!(await api(req, res, new URL(req.url || '/', 'http://localhost')))) { res.writeHead(404); res.end('{}'); }
});
after(() => { server.close(); });

const FACILITY = 'fac-luth-001';
const doctor = rt.seedData.clinicians.find((c) => c.facilityId === FACILITY && c.status === 'VERIFIED')!;
const otherDoctor = rt.seedData.clinicians.find((c) => c.facilityId !== FACILITY && c.status === 'VERIFIED')!;
const patients = rt.seedData.patients.map((p) => p.patient);
const [p1, p2, p3] = patients;
const codeOf = (id: string) => rt.codeByPatient.get(id)!.formattedCode;

async function call(method: string, p: string, body?: unknown, token?: string) {
  const r = await fetch(`${base}${p}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) as any };
}
const login = async (id: string) => (await call('POST', '/api/clinician/login', { clinicianId: id, totp: generateTotp(rt.staff.demoTotpSecret(id)!) })).body.token as string;
const breakGlass = async (token: string, patientId: string) => {
  const r = await call('POST', '/api/emergency/break-glass', { code: codeOf(patientId), reason: 'UNCONSCIOUS' }, token);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return r.body.grantId as string;
};
const payload = (over: Record<string, unknown> = {}) => ({
  patientRef: 'PT-synthetic', agentRunId: 'run-1', colour: 'RED', tews: 9,
  factors: [{ name: 'heartRate', value: '118', points: 2 }, { name: 'avpu', value: 'voice', points: 1 }],
  reasons: ['TEWS 9 >= 7'],
  essentials: { age: 28, gender: 'FEMALE', bloodGroup: 'O POSITIVE', genotype: 'SS', alerts: ['Drug allergy on record: Penicillin.'] },
  referralOptions: [
    { facilityId: 'NG-LAG-001', name: 'Demo General Hospital Ikeja', distanceKm: 11, level: 'tertiary', icuBedsFree: 2 },
    { facilityId: 'NG-ABJ-001', name: 'Demo National Hospital Abuja', distanceKm: 537, level: 'tertiary', icuBedsFree: 3 },
  ],
  handoverText: '# Emergency handover\nRED (TEWS 9)\n<script>alert(1)</script>',
  ...over,
});

let token = '';
let otherToken = '';
let g1 = '', g2 = '', g3 = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  token = await login(doctor.id);
  otherToken = await login(otherDoctor.id);
  g1 = await breakGlass(token, p1.id);
  g2 = await breakGlass(token, p2.id);
  g3 = await breakGlass(token, p3.id);
});

describe('Triage board', () => {
  test('A clinician posts the agent result against their own grant; it is audited and never a clinical record', async () => {
    const recordsBefore = JSON.stringify((rt.clinicalStore as any).patientIndex.get(p1.id) || []);
    const auditBefore = rt.auditManager.getChain().length;
    const r = await call('POST', `/api/emergency/grants/${g1}/triage`, payload(), token);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual([r.body.colour, r.body.tews, r.body.boardUrl], ['RED', 9, '/clinicians/triage']);
    const entries = rt.auditManager.getChain();
    assert.ok(entries.length > auditBefore);
    assert.ok(entries.some((e) => e.action === 'TRIAGE_RESULT_RECORDED' && e.subjectId === p1.id));
    assert.strictEqual(JSON.stringify((rt.clinicalStore as any).patientIndex.get(p1.id) || []), recordsBefore, 'no clinical record written');
  });

  test('Patients, anonymous callers and other clinicians cannot post or read the board', async () => {
    assert.strictEqual((await call('POST', `/api/emergency/grants/${g1}/triage`, payload())).status, 401);
    assert.strictEqual((await call('GET', '/api/clinician/triage/board')).status, 401);
    assert.strictEqual((await call('POST', `/api/emergency/grants/${g1}/triage`, payload(), otherToken)).status, 403);
    assert.strictEqual((await call('POST', `/api/emergency/grants/not-a-grant/triage`, payload(), token)).status, 404);
    // Another facility's board does not show this facility's patients.
    const other = await call('GET', '/api/clinician/triage/board', undefined, otherToken);
    assert.strictEqual(other.status, 200);
    assert.ok(!other.body.patients.some((r: any) => r.id && r.facilityId === FACILITY));
  });

  test('Bad payloads are rejected', async () => {
    for (const bad of [payload({ colour: 'PURPLE' }), payload({ tews: -1 }), payload({ tews: 99 }),
      payload({ referralOptions: new Array(6).fill({ facilityId: 'x', name: 'x', distanceKm: 1, level: 'x', icuBedsFree: 0 }) })]) {
      assert.strictEqual((await call('POST', `/api/emergency/grants/${g2}/triage`, bad, token)).status, 400);
    }
    assert.throws(() => parseTriagePayload({ colour: 'RED' }), TriageValidationError);
    // The target time follows the colour, whatever the payload says.
    assert.strictEqual(parseTriagePayload({ colour: 'ORANGE', tews: 5, targetMinutes: 999 }).targetMinutes, 10);
  });

  test('The board is sorted RED, ORANGE, YELLOW, GREEN and shows no names or patient ids', async () => {
    await call('POST', `/api/emergency/grants/${g2}/triage`, payload({ colour: 'GREEN', tews: 1, patientRef: 'PT-green' }), token);
    await call('POST', `/api/emergency/grants/${g3}/triage`, payload({ colour: 'ORANGE', tews: 5, patientRef: 'PT-orange' }), token);
    const b = await call('GET', '/api/clinician/triage/board', undefined, token);
    assert.strictEqual(b.status, 200);
    assert.deepStrictEqual(b.body.patients.map((r: any) => r.colour), ['RED', 'ORANGE', 'GREEN']);
    const text = JSON.stringify(b.body);
    for (const p of [p1, p2, p3]) {
      assert.ok(!text.includes(p.id), 'no patient id');
      assert.ok(!text.includes(codeOf(p.id)), 'no emergency code');
    }
    assert.match(b.body.disclaimer, /Decision support only/);
  });

  test('A rising TEWS marks the patient as deteriorating', async () => {
    let b = await call('GET', '/api/clinician/triage/board', undefined, token);
    assert.strictEqual(b.body.patients.find((r: any) => r.patientRef === 'PT-orange').deteriorating, false);
    await call('POST', `/api/emergency/grants/${g3}/triage`, payload({ colour: 'RED', tews: 8, patientRef: 'PT-orange' }), token);
    b = await call('GET', '/api/clinician/triage/board', undefined, token);
    const row = b.body.patients.find((r: any) => r.patientRef === 'PT-orange');
    assert.deepStrictEqual([row.colour, row.deteriorating, row.previousTews], ['RED', true, 5]);
    assert.strictEqual(b.body.patients.length, 3, 'latest result per patient only');
  });

  test('Accepting a referral: only a suggested facility, once, audited; the patient sees only where they were referred', async () => {
    const b = await call('GET', '/api/clinician/triage/board', undefined, token);
    const row = b.body.patients.find((r: any) => r.patientRef === 'PT-synthetic');
    assert.strictEqual((await call('POST', `/api/clinician/triage/${row.id}/accept-referral`, { facilityId: 'NG-NOT-LISTED' }, token)).status, 400);
    assert.strictEqual((await call('POST', `/api/clinician/triage/${row.id}/accept-referral`, { facilityId: 'NG-LAG-001' }, otherToken)).status, 404);
    const ok = await call('POST', `/api/clinician/triage/${row.id}/accept-referral`, { facilityId: 'NG-LAG-001' }, token);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.acceptedReferral.name, 'Demo General Hospital Ikeja');
    assert.strictEqual((await call('POST', `/api/clinician/triage/${row.id}/accept-referral`, { facilityId: 'NG-LAG-001' }, token)).status, 200, 'idempotent');
    assert.strictEqual((await call('POST', `/api/clinician/triage/${row.id}/accept-referral`, { facilityId: 'NG-ABJ-001' }, token)).status, 400, 'no second referral');
    assert.ok(rt.auditManager.getChain().some((e) => e.action === 'REFERRAL_ACCEPTED' && e.subjectId === p1.id));

    const refs = await call('GET', `/api/patients/${p1.id}/referrals`); // demo mode: the portal reads without sign-in
    assert.strictEqual(refs.status, 200);
    assert.deepStrictEqual(refs.body.referrals.map((r: any) => r.facilityName), ['Demo General Hospital Ikeja']);
    assert.ok(!JSON.stringify(refs.body).includes('TEWS'), 'no triage score for the patient');
    assert.deepStrictEqual((await call('GET', `/api/patients/${p2.id}/referrals`)).body.referrals, []);
  });

  test('Handover text is returned as data (the page escapes it); the emergency card never carries triage data', async () => {
    const b = await call('GET', '/api/clinician/triage/board', undefined, token);
    const row = b.body.patients.find((r: any) => r.patientRef === 'PT-synthetic');
    assert.ok(row.handoverText.includes('<script>alert(1)</script>'), 'stored verbatim as text');
    assert.ok(row.handoverText.includes('\n'), 'line breaks kept');
    const card = await call('GET', `/api/patients/${p1.id}/offline-card`);
    assert.ok(!JSON.stringify(card.body).includes('TEWS'));
  });
});
