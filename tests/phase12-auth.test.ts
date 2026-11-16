// Phase 12: real authentication with DEMO_MODE=0. Patient phone sign-in (OTP), recovery and session revocation;
// clinician password + TOTP with lockout; self-registration and admin review; guardian / proxy access.
// Runs the portal API in-process (so the simulated SMS outbox can be read) with DEMO_MODE=0 set before import.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { hashPassword, generateTotp, generateTotpSecret, toRfc4648Base32, fromRfc4648Base32 } from '../src/lib/auth/security.ts';

import { startMockClamd } from './mockClamd.ts';

process.env.DEMO_MODE = '0';
process.env.TRUST_PROXY = '1';
// Real-data mode scans uploads with clamd and fails closed (Phase 14), so these tests run a stand-in clamd.
const clamd = await startMockClamd();
process.env.CLAMD_HOST = '127.0.0.1';
process.env.CLAMD_PORT = String(clamd.port); // each group sends its own X-Forwarded-For, so per-IP limits do not collide
const adminTotpBytes = crypto.randomBytes(20);
process.env.PLATFORM_ADMIN_EMAIL = 'platform-admin@example.org';
process.env.PLATFORM_ADMIN_PASSWORD_HASH = await hashPassword('synthetic-admin-password');
process.env.PLATFORM_ADMIN_TOTP_SECRET = toRfc4648Base32(adminTotpBytes);

const { createRuntime } = await import('../src/lib/runtime.ts');
const { createMemoryPersistence } = await import('../src/lib/data/memory/persistence.ts');
const { createPortalApi } = await import('../src/lib/site/portalApi.ts');
const { evaluatePolicy } = await import('../src/lib/policy/enforcer.ts');
const { majorityDate } = await import('../src/lib/auth/proxies.ts');
const { DEMO_MODE } = await import('../src/lib/security/config.ts');

const rt = await createRuntime(createMemoryPersistence());
const api = createPortalApi({
  ...rt, notifications: rt.consoleProvider, offlineCards: rt.offlineCardStore, dataDir: path.join(os.tmpdir(), 'medistry-phase12'),
});
let base = '';
const server = http.createServer(async (req, res) => {
  if (!(await api(req, res, new URL(req.url || '/', 'http://localhost')))) { res.writeHead(404); res.end('{}'); }
});

type Res = { status: number; body: any };
async function call(method: string, p: string, opts: { body?: unknown; token?: string; ip?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Forwarded-For': opts.ip || '10.0.0.1' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const r = await fetch(`${base}${p}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const post = (p: string, body: unknown, opts: { token?: string; ip?: string } = {}) => call('POST', p, { ...opts, body });
const get = (p: string, opts: { token?: string; ip?: string } = {}) => call('GET', p, opts);

/** The newest 6-digit code sent to this phone number or email (the simulated handset / inbox). */
function lastCode(to: string): string {
  const all = [...rt.consoleProvider.sentSmsLogs.map((s) => ({ to: s.to, text: s.message })), ...rt.consoleProvider.sentEmailLogs.map((e) => ({ to: e.to, text: e.body }))];
  const hit = all.filter((m) => m.to === to).at(-1);
  const code = hit?.text.match(/\b(\d{6})\b/)?.[1];
  assert.ok(code, `a code was sent to ${to}`);
  return code!;
}
const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

async function signIn(phone: string, ip = '10.0.1.1'): Promise<string> {
  assert.strictEqual((await post('/api/auth/patient/otp/request', { phone }, { ip })).status, 200);
  const r = await post('/api/auth/patient/otp/verify', { phone, otp: lastCode(phone) }, { ip });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}

/** TOTP code for an otpauth:// URI, computed the way an authenticator app does (from the RFC 4648 secret). */
const totpFromUri = (uri: string, at = Date.now()) => generateTotp(generateTotpSecret(20, fromRfc4648Base32(new URL(uri).searchParams.get('secret')!)), at);
const licenceDocument = { filename: 'licence.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('%PDF-1.4 synthetic licence').toString('base64') };

const patientA = rt.seedData.patients[0].patient;
const patientB = rt.seedData.patients[1].patient;
const patientC = rt.seedData.patients[2].patient;
const PHONE_A = '+2348000000201';
const PHONE_B = '+2348000000202';
let adminToken = '';
let facilityAdminUri = '';
let facilityAdminId = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.strictEqual(DEMO_MODE, false, 'these tests run with DEMO_MODE=0');
  // Platform admin from the environment (password + TOTP), who links two patients' phone numbers.
  const login = await post('/api/admin/login', { email: 'platform-admin@example.org', password: 'synthetic-admin-password', totp: generateTotp(generateTotpSecret(20, adminTotpBytes)) }, { ip: '10.9.0.1' });
  assert.strictEqual(login.status, 200, JSON.stringify(login.body));
  adminToken = login.body.token;
  for (const [p, phone] of [[patientA, PHONE_A], [patientB, PHONE_B]] as const) {
    const r = await post(`/api/admin/patients/${p.id}/account`, { phone }, { token: adminToken, ip: '10.9.0.1' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  }
  const fa = await post('/api/admin/facility-admins', { name: 'Synthetic Facility Admin', email: 'fa@example.org', facilityId: 'fac-luth-001', password: 'synthetic-fa-password' }, { token: adminToken, ip: '10.9.0.1' });
  assert.strictEqual(fa.status, 200, JSON.stringify(fa.body));
  facilityAdminUri = fa.body.totpEnrolment.otpauthUri;
  facilityAdminId = fa.body.adminId;
});
after(async () => { server.close(); await clamd.close(); });

describe('Patient sign-in by SMS one-time code', () => {
  test('Success: the code sent by SMS signs the patient in to their own record', async () => {
    const r = await post('/api/auth/patient/otp/request', { phone: PHONE_A }, { ip: '10.1.0.1' });
    assert.deepStrictEqual([r.status, r.body.expiresInSeconds], [200, 300]);
    const v = await post('/api/auth/patient/otp/verify', { phone: PHONE_A, otp: lastCode(PHONE_A) }, { ip: '10.1.0.1' });
    assert.strictEqual(v.status, 200);
    assert.strictEqual(v.body.account.patientId, patientA.id);
    assert.strictEqual(v.body.account.phone.includes('0000201'), false, 'the phone number is masked');
    assert.strictEqual((await get(`/api/patients/${patientA.id}`, { token: v.body.token, ip: '10.1.0.1' })).status, 200);
    assert.ok(rt.auditManager.getEntries().some((e) => e.action === 'PATIENT_SIGNED_IN' && e.subjectId === patientA.id), 'sign-in audited');
    // The code is single use.
    assert.strictEqual((await post('/api/auth/patient/otp/verify', { phone: PHONE_A, otp: lastCode(PHONE_A) }, { ip: '10.1.0.1' })).status, 401);
  });

  test('The code is stored only as a hash, never in plain text (memory or message log)', async () => {
    const phone = '+2348000000301';
    const stored: Array<{ body: string }> = [];
    const keep = rt.consoleProvider.persistence;
    rt.consoleProvider.persistence = { saveNotification: (n) => { stored.push(n); } };
    try {
      assert.strictEqual((await post('/api/auth/patient/otp/request', { phone }, { ip: '10.1.0.2' })).status, 200);
    } finally {
      rt.consoleProvider.persistence = keep;
    }
    const code = lastCode(phone);
    const challenges = rt.patientAuth.storedChallenges();
    assert.ok(challenges.length >= 1);
    for (const c of challenges) {
      assert.match(c.otpHash, /^[0-9a-f]{64}$/);
      assert.ok(!Object.values(c).some((v) => v === code || v === Number(code)), 'no field holds the code');
    }
    assert.ok(!JSON.stringify(challenges).includes(code), 'the code is not in the stored challenge');
    assert.strictEqual(stored.length, 1);
    assert.ok(!stored[0].body.includes(code), 'the stored message log has no code');
  });

  test('A code expires after 5 minutes', async () => {
    const phone = '+2348000000302';
    assert.strictEqual((await post('/api/auth/patient/otp/request', { phone }, { ip: '10.1.0.3' })).status, 200);
    const code = lastCode(phone);
    const info = { ipAddress: '10.1.0.3', userAgent: 'test' };
    assert.throws(() => rt.patientAuth.verifySignInCode(phone, code, info, Date.now() + 5 * 60_000 + 1000), (err: any) => err.status === 401 && /expired/.test(err.message));
    // and the expired code is gone
    assert.strictEqual((await post('/api/auth/patient/otp/verify', { phone, otp: code }, { ip: '10.1.0.3' })).status, 401);
  });

  test('Five wrong codes lock the code out (even the right one then fails)', async () => {
    const phone = '+2348000000303';
    assert.strictEqual((await post('/api/auth/patient/otp/request', { phone }, { ip: '10.1.0.4' })).status, 200);
    const code = lastCode(phone);
    for (let i = 0; i < 5; i++) {
      assert.strictEqual((await post('/api/auth/patient/otp/verify', { phone, otp: wrong(code) }, { ip: '10.1.0.4' })).status, 401);
    }
    const locked = await post('/api/auth/patient/otp/verify', { phone, otp: code }, { ip: '10.1.0.4' });
    assert.strictEqual(locked.status, 429);
    assert.match(locked.body.error, /Too many wrong codes/);
    assert.ok(rt.auditManager.getEntries().some((e) => e.action === 'ONE_TIME_CODE_LOCKED'), 'lockout audited');
  });

  test('Code requests are rate limited per phone number and per IP address', async () => {
    const phone = '+2348000000304';
    for (let i = 0; i < 3; i++) assert.strictEqual((await post('/api/auth/patient/otp/request', { phone }, { ip: `10.1.1.${i}` })).status, 200);
    assert.strictEqual((await post('/api/auth/patient/otp/request', { phone }, { ip: '10.1.1.9' })).status, 429, 'per phone');
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await post('/api/auth/patient/otp/request', { phone: `+23480000004${String(i).padStart(2, '0')}` }, { ip: '10.1.2.1' })).status);
    assert.deepStrictEqual([statuses.slice(0, 10).every((s) => s === 200), statuses[10]], [true, 429], 'per IP');
    assert.strictEqual((await post('/api/auth/patient/otp/request', { phone: '12345' }, { ip: '10.1.2.2' })).status, 400, 'invalid number');
  });
});

describe('Patient routes with DEMO_MODE=0', () => {
  test('No session is 401; patient A cannot read patient B; A reads A', async () => {
    assert.strictEqual((await get(`/api/patients/${patientA.id}`, { ip: '10.2.0.1' })).status, 401);
    assert.strictEqual((await get(`/api/patients/${patientA.id}/timeline`, { ip: '10.2.0.1' })).status, 401);
    assert.strictEqual((await get(`/api/patients/${patientA.id}`, { token: 'forged.token', ip: '10.2.0.1' })).status, 401);
    const tokenA = await signIn(PHONE_A, '10.2.0.1');
    for (const sub of ['', '/timeline', '/access-log', '/consents', '/offline-cards']) {
      assert.strictEqual((await get(`/api/patients/${patientB.id}${sub}`, { token: tokenA, ip: '10.2.0.1' })).status, 403, `B${sub}`);
    }
    assert.strictEqual((await call('PATCH', `/api/patients/${patientB.id}/settings`, { token: tokenA, ip: '10.2.0.1', body: { publicEmergencyOptIn: true } })).status, 403);
    const own = await get(`/api/patients/${patientA.id}`, { token: tokenA, ip: '10.2.0.1' });
    assert.deepStrictEqual([own.status, own.body.patient.id], [200, patientA.id]);
    // A clinician or admin token is not a patient session (Phase 18: refused outright with 403).
    assert.strictEqual((await get(`/api/patients/${patientA.id}`, { token: adminToken, ip: '10.2.0.1' })).status, 403);
  });

  test('Sign out everywhere revokes existing sessions and is audited', async () => {
    const t1 = await signIn(PHONE_B, '10.2.0.2');
    await new Promise((r) => setTimeout(r, 5));
    assert.strictEqual((await post('/api/auth/patient/sessions/revoke', {}, { token: t1, ip: '10.2.0.2' })).status, 200);
    assert.strictEqual((await get(`/api/patients/${patientB.id}`, { token: t1, ip: '10.2.0.2' })).status, 401);
    assert.ok(rt.auditManager.getEntries().some((e) => e.action === 'SESSIONS_REVOKED' && e.subjectId === patientB.id));
    const t2 = await signIn(PHONE_B, '10.2.0.3');
    assert.strictEqual((await post('/api/auth/patient/logout', {}, { token: t2, ip: '10.2.0.3' })).status, 200);
    assert.strictEqual((await get(`/api/patients/${patientB.id}`, { token: t2, ip: '10.2.0.3' })).status, 401, 'signed-out token');
    assert.ok(rt.auditManager.getEntries().some((e) => e.action === 'SESSION_REVOKED' && e.subjectId === patientB.id));
  });

  test('Recovery: code to the recovery email, then a code to the new phone; old sessions are revoked', async () => {
    const oldToken = await signIn(PHONE_B, '10.2.1.1');
    assert.strictEqual((await post('/api/auth/patient/recovery-email', { email: 'patient-b@example.org' }, { token: oldToken, ip: '10.2.1.1' })).status, 200);
    const confirm = await post('/api/auth/patient/recovery-email/verify', { email: 'patient-b@example.org', otp: lastCode('patient-b@example.org') }, { token: oldToken, ip: '10.2.1.1' });
    assert.strictEqual(confirm.body.account.hasRecoveryEmail, true);
    await new Promise((r) => setTimeout(r, 5));

    const newPhone = '+2348000000299';
    assert.strictEqual((await post('/api/auth/patient/recovery/request', { email: 'patient-b@example.org', newPhone }, { ip: '10.2.1.2' })).status, 200);
    assert.strictEqual((await post('/api/auth/patient/recovery/request', { email: 'nobody@example.org', newPhone }, { ip: '10.2.1.2' })).status, 200, 'same answer for an unknown email');
    const step2 = await post('/api/auth/patient/recovery/verify-email', { email: 'patient-b@example.org', otp: lastCode('patient-b@example.org') }, { ip: '10.2.1.2' });
    assert.strictEqual(step2.body.next, 'verify-new-phone');
    const done = await post('/api/auth/patient/recovery/complete', { newPhone, otp: lastCode(newPhone) }, { ip: '10.2.1.2' });
    assert.strictEqual(done.status, 200, JSON.stringify(done.body));
    assert.strictEqual(done.body.account.patientId, patientB.id);
    assert.strictEqual((await get(`/api/patients/${patientB.id}`, { token: oldToken, ip: '10.2.1.2' })).status, 401, 'old session revoked');
    assert.strictEqual((await get(`/api/patients/${patientB.id}`, { token: done.body.token, ip: '10.2.1.2' })).status, 200);
    const actions = rt.auditManager.getEntries().filter((e) => e.subjectId === patientB.id).map((e) => e.action);
    for (const a of ['RECOVERY_EMAIL_ADDED', 'ACCOUNT_RECOVERED', 'SESSIONS_REVOKED']) assert.ok(actions.includes(a), a);
    assert.ok(rt.consoleProvider.sentSmsLogs.some((s) => s.to === PHONE_B && /moved to a new phone number/.test(s.message)), 'old number told');
  });
});

describe('Clinician password + TOTP, registration and review', () => {
  let verifiedId = '';
  let verifiedUri = '';
  let pendingId = '';
  let pendingUri = '';

  test('Self-registration validates the licence, stores the document encrypted, and starts PENDING', async () => {
    const bad = await post('/api/clinician/register', { name: 'Dr. Synthetic Bad', phone: '+2348000000501', email: 'bad@example.org', countryCode: 'NG', licenceNumber: 'NOT-A-LICENCE', facilityRegistryCode: 'fac-luth-001', password: 'synthetic-password-1', licenceDocument }, { ip: '10.3.0.1' });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.body.error, /MDCN/);
    const a = await post('/api/clinician/register', { name: 'Dr. Synthetic Verified', phone: '+2348000000502', email: 'verified@example.org', countryCode: 'NG', licenceNumber: 'MDCN/R/77002', facilityRegistryCode: 'fac-luth-001', password: 'synthetic-password-2', licenceExpiresOn: '2099-01-01', licenceDocument }, { ip: '10.3.0.1' });
    assert.strictEqual(a.status, 200, JSON.stringify(a.body));
    assert.strictEqual(a.body.status, 'PENDING');
    assert.match(a.body.totpEnrolment.otpauthUri, /^otpauth:\/\/totp\/Medistry:verified%40example\.org\?secret=[A-Z2-7]+&issuer=Medistry/);
    assert.match(a.body.totpEnrolment.qrSvg, /^<svg/);
    verifiedId = a.body.clinicianId;
    verifiedUri = a.body.totpEnrolment.otpauthUri;
    const b = await post('/api/clinician/register', { name: 'Dr. Synthetic Pending', phone: '+2348000000503', email: 'pending@example.org', countryCode: 'KE', licenceNumber: 'DEMO-KE-9001', facilityRegistryCode: 'DEMO-KMFL-0001', password: 'synthetic-password-3', licenceDocument }, { ip: '10.3.0.1' });
    assert.strictEqual(b.status, 200, JSON.stringify(b.body));
    pendingId = b.body.clinicianId;
    pendingUri = b.body.totpEnrolment.otpauthUri;
    assert.strictEqual((await post('/api/clinician/register', { name: 'Dr. Synthetic Dup', phone: '+2348000000504', email: 'dup@example.org', countryCode: 'NG', licenceNumber: 'MDCN/R/77002', facilityRegistryCode: 'fac-luth-001', password: 'synthetic-password-4', licenceDocument }, { ip: '10.3.0.1' })).status, 409, 'duplicate licence');
    assert.ok(rt.auditManager.getEntries().some((e) => e.action === 'CLINICIAN_REGISTERED' && e.resourceId === verifiedId));
  });

  test('A facility admin of the claimed facility approves; another facility\'s admin cannot; review is audited', async () => {
    const login = await post('/api/admin/login', { email: 'fa@example.org', password: 'synthetic-fa-password', totp: totpFromUri(facilityAdminUri) }, { ip: '10.3.1.1' });
    assert.strictEqual(login.status, 200, JSON.stringify(login.body));
    const fa = login.body.token;
    const list = await get('/api/admin/clinicians?status=PENDING', { token: fa, ip: '10.3.1.1' });
    assert.deepStrictEqual(list.body.clinicians.map((c: { id: string }) => c.id), [verifiedId], 'own facility only');
    const doc = await get(`/api/admin/clinicians/${verifiedId}/licence-document`, { token: fa, ip: '10.3.1.1' });
    assert.strictEqual(Buffer.from(doc.body.document.contentBase64, 'base64').toString(), '%PDF-1.4 synthetic licence');
    assert.strictEqual((await post(`/api/admin/clinicians/${pendingId}/approve`, {}, { token: fa, ip: '10.3.1.1' })).status, 403, 'a Kenyan facility is not theirs');
    const ok = await post(`/api/admin/clinicians/${verifiedId}/approve`, {}, { token: fa, ip: '10.3.1.1' });
    assert.deepStrictEqual([ok.status, ok.body.status], [200, 'VERIFIED']);
    const entry = rt.auditManager.getEntries().find((e) => e.action === 'CLINICIAN_APPROVED' && e.resourceId === verifiedId)!;
    assert.strictEqual(entry.actorId, facilityAdminId);
    assert.ok(rt.consoleProvider.sentSmsLogs.some((s) => s.to === '+2348000000502' && /verified/.test(s.message)), 'clinician told');
  });

  test('Password + TOTP sign-in succeeds; TOTP alone does not (DEMO_MODE=0); the demo authenticator is gone', async () => {
    const ip = '10.3.2.1';
    const r = await post('/api/clinician/login', { email: 'verified@example.org', password: 'synthetic-password-2', totp: totpFromUri(verifiedUri) }, { ip });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.clinician.status, 'VERIFIED');
    assert.strictEqual((await get('/api/clinician/me', { token: r.body.token, ip })).status, 200);
    assert.strictEqual((await post('/api/clinician/login', { clinicianId: verifiedId, totp: totpFromUri(verifiedUri) }, { ip })).status, 401, 'password required');
    const seeded = rt.seedData.clinicians[0];
    assert.strictEqual((await post('/api/clinician/login', { clinicianId: seeded.id, totp: '000000' }, { ip })).status, 401, 'seeded demo clinician has no password');
    assert.strictEqual((await get(`/api/demo/totp/${seeded.id}`, { ip })).status, 404, 'demo TOTP endpoint only when DEMO_MODE=1');
    assert.ok(rt.accounts.get(rt.seedData.clinicians.find((c) => c.id === verifiedId)!.userId)!.passwordHash!.startsWith('scrypt$N=32768,r=8,p=1$'));
  });

  test('Five failures lock the clinician out, even with the right password and code', async () => {
    const ip = '10.3.3.1';
    // A success resets the count (the TOTP-only attempt in the previous test was a failure).
    assert.strictEqual((await post('/api/clinician/login', { clinicianId: verifiedId, password: 'synthetic-password-2', totp: totpFromUri(verifiedUri) }, { ip: '10.3.3.8' })).status, 200);
    for (let i = 0; i < 5; i++) {
      assert.strictEqual((await post('/api/clinician/login', { clinicianId: verifiedId, password: 'wrong-password-123', totp: totpFromUri(verifiedUri) }, { ip: `${ip}${i}` })).status, 401);
    }
    const locked = await post('/api/clinician/login', { clinicianId: verifiedId, password: 'synthetic-password-2', totp: totpFromUri(verifiedUri) }, { ip: '10.3.3.9' });
    assert.strictEqual(locked.status, 429);
    assert.match(locked.body.error, /Too many failed attempts/);
  });

  test('A PENDING clinician can sign in but cannot break glass, scan in clinician mode or read records', async () => {
    const ip = '10.3.4.1';
    const r = await post('/api/clinician/login', { clinicianId: pendingId, password: 'synthetic-password-3', totp: totpFromUri(pendingUri) }, { ip });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.clinician.status, 'PENDING');
    const token = r.body.token;
    const code = rt.codeByPatient.get(patientA.id)!.formattedCode;
    const bg = await post('/api/emergency/break-glass', { code, reason: 'UNCONSCIOUS' }, { token, ip });
    assert.strictEqual(bg.status, 403);
    assert.match(bg.body.error, /pending verification/);
    const kp = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const publicJwk = await globalThis.crypto.subtle.exportKey('jwk', kp.publicKey);
    assert.strictEqual((await post('/api/clinician/device-key', { publicJwk }, { token, ip })).status, 403, 'no offline scanner pass');
    assert.strictEqual((await get(`/api/clinician/patients/${patientA.id}/record`, { token, ip })).status, 403);
    assert.strictEqual((await post('/api/clinician/lookup', { code }, { token, ip })).status, 403);
    assert.ok(!rt.emergencyEngine.getActiveGrantsForClinician(pendingId).length, 'no grant was created');
  });

  test('A re-verification reminder is sent once before a recorded licence expiry', async () => {
    const shortlyBefore = Date.parse('2099-01-01') - 10 * 86_400_000;
    assert.strictEqual(await rt.staff.sendLicenceReminders(Date.parse('2098-06-01')), 0, 'too early');
    assert.strictEqual(await rt.staff.sendLicenceReminders(shortlyBefore), 1);
    assert.strictEqual(await rt.staff.sendLicenceReminders(shortlyBefore), 0, 'once per expiry date');
    assert.ok(rt.consoleProvider.sentSmsLogs.some((s) => s.to === '+2348000000502' && /expires on 2099-01-01/.test(s.message)));
    assert.ok(rt.auditManager.getEntries().some((e) => e.action === 'LICENCE_REVERIFICATION_REMINDER' && e.resourceId === verifiedId));
  });
});

describe('Guardian and proxy access', () => {
  const PROXY_VIEW = '+2348000000601';
  const PROXY_CARD = '+2348000000602';

  test('A view-scope proxy can read but cannot change consent; actions are audited under the proxy identity', async () => {
    const ip = '10.4.0.1';
    const tokenA = await signIn(PHONE_A, ip);
    const inv1 = await post(`/api/patients/${patientA.id}/proxies`, { phone: PROXY_VIEW, relationship: 'caregiver', scopes: ['view'] }, { token: tokenA, ip });
    assert.strictEqual(inv1.status, 200, JSON.stringify(inv1.body));
    const inv2 = await post(`/api/patients/${patientA.id}/proxies`, { phone: PROXY_CARD, relationship: 'spouse', scopes: ['view', 'manage-card'] }, { token: tokenA, ip });
    assert.strictEqual(inv2.status, 200);

    // The view proxy signs in with their own phone and accepts.
    const tokenP = await signIn(PROXY_VIEW, '10.4.0.2');
    const me = await get('/api/auth/patient/me', { token: tokenP, ip: '10.4.0.2' });
    assert.strictEqual(me.body.account.role, 'PROXY');
    assert.deepStrictEqual(me.body.invitations.map((i: { id: string }) => i.id), [inv1.body.proxy.id]);
    assert.strictEqual((await get(`/api/patients/${patientA.id}`, { token: tokenP, ip: '10.4.0.2' })).status, 403, 'not before accepting');
    assert.strictEqual((await post(`/api/auth/patient/proxy-invitations/${inv1.body.proxy.id}/accept`, {}, { token: tokenP, ip: '10.4.0.2' })).status, 200);

    const read = await get(`/api/patients/${patientA.id}`, { token: tokenP, ip: '10.4.0.2' });
    assert.strictEqual(read.status, 200);
    assert.strictEqual(read.body.actingAs.relationship, 'caregiver');
    assert.strictEqual((await get(`/api/patients/${patientA.id}/timeline`, { token: tokenP, ip: '10.4.0.2' })).status, 200);
    assert.strictEqual((await get(`/api/patients/${patientB.id}`, { token: tokenP, ip: '10.4.0.2' })).status, 403, 'only the patient who invited them');

    const grant = rt.consentManager.getPatientConsents(patientA.id)[0];
    const revoke = await post(`/api/patients/${patientA.id}/consents/grants/${grant?.id || 'none'}/revoke`, { reason: 'proxy tries' }, { token: tokenP, ip: '10.4.0.2' });
    assert.strictEqual(revoke.status, 403);
    assert.match(revoke.body.error, /approve-consent/);
    assert.strictEqual((await post(`/api/patients/${patientA.id}/consents/requests/any/approve`, {}, { token: tokenP, ip: '10.4.0.2' })).status, 403);
    assert.strictEqual((await call('PATCH', `/api/patients/${patientA.id}/settings`, { token: tokenP, ip: '10.4.0.2', body: { publicEmergencyOptIn: true } })).status, 403, 'no manage-card scope');
    const proxyAccount = rt.accounts.byPhoneNumber(PROXY_VIEW)!;
    assert.ok(rt.auditManager.getEntries().some((e) => e.action === 'PROXY_ACCEPTED' && e.actorId === proxyAccount.id && e.subjectId === patientA.id));

    // A manage-card proxy changes a card setting: the audit entry names the proxy, on behalf of the patient.
    const tokenQ = await signIn(PROXY_CARD, '10.4.0.3');
    await post(`/api/auth/patient/proxy-invitations/${inv2.body.proxy.id}/accept`, {}, { token: tokenQ, ip: '10.4.0.3' });
    const before = patientA.publicEmergencyOptIn;
    const patch = await call('PATCH', `/api/patients/${patientA.id}/settings`, { token: tokenQ, ip: '10.4.0.3', body: { publicEmergencyOptIn: !before } });
    assert.strictEqual(patch.status, 200, JSON.stringify(patch.body));
    const q = rt.accounts.byPhoneNumber(PROXY_CARD)!;
    const entry = rt.auditManager.getEntries().filter((e) => e.action === 'PATIENT_UPDATED_PUBLIC_BADGE_SETTING').at(-1)!;
    assert.strictEqual(entry.actorId, q.id, 'the proxy, not the patient, is the actor');
    assert.strictEqual(entry.subjectId, patientA.id);
    assert.match(entry.reason!, new RegExp(`^Proxy ${q.id} \\(spouse\\) on behalf of patient ${patientA.id}: `));
    assert.strictEqual(rt.auditManager.verifyChain().valid, true);

    // No scope edits clinical content.
    const decision = evaluatePolicy({ actor: { userId: patientA.id, role: 'PATIENT', proxyUserId: q.id }, action: 'PATIENT_WRITE_RECORD', targetPatientId: patientA.id });
    assert.deepStrictEqual([decision.allowed, decision.reason], [false, 'Proxies can never edit clinical content']);

    // The patient revokes; the proxy loses access at once.
    assert.strictEqual((await post(`/api/patients/${patientA.id}/proxies/${inv1.body.proxy.id}/revoke`, {}, { token: tokenA, ip })).status, 200);
    assert.strictEqual((await get(`/api/patients/${patientA.id}`, { token: tokenP, ip: '10.4.0.2' })).status, 403);
  });

  test("A guardian's control ends at the patient's 18th birthday (computed from the encrypted DOB)", async () => {
    const birthday18 = majorityDate(patientC).getTime();
    const info = { ipAddress: '10.4.1.1', userAgent: 'test' };
    const platformAdmin = rt.accounts.byEmailAddress('platform-admin@example.org')!;
    // Seeded patients are adults today, so an admin cannot record a guardian for them now...
    const now = await post(`/api/admin/patients/${patientC.id}/guardian`, { phone: '+2348000000701', relationship: 'parent' }, { token: adminToken, ip: '10.9.0.1' });
    assert.strictEqual(now.status, 400);
    assert.match(now.body.error, /18 or older/);
    // ...so the clock is set to a month before patient C's 18th birthday.
    const monthBefore = birthday18 - 30 * 86_400_000;
    const rel = await rt.proxies.establishGuardian(patientC, { phone: '+2348000000701', relationship: 'parent' }, platformAdmin, info, monthBefore);
    assert.strictEqual(rel.validUntil, new Date(birthday18).toISOString());
    const guardian = rt.accounts.byPhoneNumber('+2348000000701')!;
    const own = rt.patientAuth.linkPatient(patientC, '+2348000000702', { ...info, adminId: platformAdmin.id });

    const dayBefore = birthday18 - 86_400_000;
    const acting = rt.proxies.authorize(guardian, patientC, 'approve-consent', dayBefore);
    assert.deepStrictEqual([acting?.proxyUserId, acting?.relationship], [guardian.id, 'parent'], 'guardian manages the account');
    assert.throws(() => rt.proxies.authorize(own, patientC, 'manage-card', dayBefore), /guardian manages this account/i, 'the minor can only view');
    assert.strictEqual(rt.proxies.authorize(own, patientC, 'view', dayBefore), null);

    assert.throws(() => rt.proxies.authorize(guardian, patientC, 'view', birthday18), (err: any) => err.status === 403, 'control ends on the birthday');
    assert.strictEqual(rt.proxies.get(rel.id)!.status, 'ENDED');
    assert.strictEqual(rt.proxies.authorize(own, patientC, 'manage-card', birthday18), null, 'the patient now controls the record');
    assert.ok(rt.auditManager.getEntries().some((e) => e.action === 'GUARDIAN_CONTROL_ENDED' && e.subjectId === patientC.id));
    assert.ok(rt.consoleProvider.sentSmsLogs.some((s) => s.to === '+2348000000701' && /turned 18/.test(s.message)), 'guardian told');
    assert.ok(rt.consoleProvider.sentSmsLogs.some((s) => s.to === '+2348000000702' && /turned 18/.test(s.message)), 'patient told');
    assert.ok(rt.consoleProvider.sentPushLogs.some((p) => p.toUserId === patientC.id && /control your record/.test(p.title)));

    const tokenG = await signIn('+2348000000701', '10.4.1.2');
    assert.strictEqual((await get(`/api/patients/${patientC.id}`, { token: tokenG, ip: '10.4.1.2' })).status, 403, 'and over HTTP');
  });
});
