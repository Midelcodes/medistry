// Phase 18: facility self-onboarding, staff administration, aggregate usage, and billing (test/sandbox providers,
// no live calls). Emergency features never depend on payment.
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
import { generateTotp, generateTotpSecret, fromRfc4648Base32 } from '../src/lib/auth/security.ts';
import { getKid } from '../src/lib/crypto/cardKeys.ts';
import { PaystackProvider } from '../src/lib/billing/PaystackProvider.ts';
import { MpesaDarajaProvider } from '../src/lib/billing/MpesaDarajaProvider.ts';
import { loadPlans } from '../src/lib/billing/BillingProvider.ts';
import { signScanEvent } from '../site/js/lib/offlineScan.js';

const rt = await createRuntime(createMemoryPersistence());
const api = createPortalApi({ ...rt, notifications: rt.consoleProvider, offlineCards: rt.offlineCardStore, dataDir: path.join(os.tmpdir(), 'medistry-phase18') });
let base = '';
const server = http.createServer(async (req, res) => {
  if (!(await api(req, res, new URL(req.url || '/', 'http://localhost')))) { res.writeHead(404); res.end('{}'); }
});
type Res = { status: number; body: any };
async function call(method: string, p: string, body?: unknown, token?: string, headers: Record<string, string> = {}): Promise<Res> {
  const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function raw(p: string, body: string, headers: Record<string, string> = {}): Promise<Res> {
  const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/** Everything sent to a phone number or email (the simulated handset / inbox), newest last. */
const inbox = (to: string) => [
  ...rt.consoleProvider.sentSmsLogs.filter((s) => s.to === to).map((s) => s.message),
  ...rt.consoleProvider.sentEmailLogs.filter((e) => e.to === to).map((e) => e.body),
];
const lastCode = (to: string) => inbox(to).at(-1)?.match(/\b(\d{6})\b/)?.[1] ?? '';
const totpFromUri = (uri: string) => generateTotp(generateTotpSecret(20, fromRfc4648Base32(new URL(uri).searchParams.get('secret')!)));
const pdf = (text: string) => ({ filename: 'accreditation.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from(`%PDF-1.4 ${text}`).toString('base64') });
const demoAdmin = async (id: string) => (await call('POST', '/api/admin/login', { adminId: id, totp: generateTotp(rt.staff.demoTotpSecret(id)!) })).body.token as string;

const ADMIN_PHONE = '+2348000001801';
const ADMIN_EMAIL = 'fa-phase18@example.org';
const application = {
  name: 'Synthetic Phase 18 Hospital', type: 'HOSPITAL', countryCode: 'NG', registryCode: 'SYN-NG-1801', address: '1 Synthetic Road',
  adminContact: { name: 'Synthetic Facility Admin', email: ADMIN_EMAIL, phone: ADMIN_PHONE },
  accreditationDocument: pdf('synthetic accreditation'),
};
const PHI_KEYS = ['name', 'firstname', 'lastname', 'fullname', 'patientid', 'patient', 'phone', 'email', 'nin', 'dateofbirth', 'dob', 'address', 'diagnosis', 'emergencycode', 'identifiers'];

let platformToken = '';
let facilityId = '';
let adminToken = '';       // the new facility's first admin (after invitation, password and authenticator)
let clinicianId = '';
let clinicianUri = '';
const clinicianPassword = 'synthetic-clinician-password-18';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  platformToken = await demoAdmin('admin-platform-demo');
});
after(() => { server.close(); });

describe('Facility self-onboarding', () => {
  test('A facility goes PENDING, then is verified (audited), then its first admin is invited and signs in with an OTP', async () => {
    const reg = await call('POST', '/api/facilities/register', application);
    assert.strictEqual(reg.status, 200, JSON.stringify(reg.body));
    assert.strictEqual(reg.body.status, 'PENDING');
    facilityId = reg.body.facilityId;
    assert.strictEqual((await call('POST', '/api/facilities/register', application)).status, 409, 'same registry code twice');

    // Not public, not usable while PENDING
    assert.strictEqual(rt.seedData.facilities.find((f) => f.id === facilityId)?.status, 'PENDING'); // /api/facilities lists VERIFIED only
    assert.strictEqual(inbox(ADMIN_PHONE).length, 0, 'no invitation before verification');
    assert.strictEqual((await call('POST', '/api/admin/facility-api-clients', { facilityId, name: 'Synthetic EMR' }, platformToken)).status, 403, 'an unverified facility cannot get API clients');
    const clin = await call('POST', '/api/clinician/register', { name: 'Dr. Synthetic Early', phone: '+2348000001899', email: 'early18@example.org', countryCode: 'NG', licenceNumber: 'MDCN/R/18999', facilityRegistryCode: 'SYN-NG-1801', password: clinicianPassword, licenceDocument: pdf('licence') });
    assert.strictEqual(clin.status, 400, 'clinicians cannot join an unverified facility');

    // The platform admin reviews the application and its document; a facility admin cannot
    const list = await call('GET', '/api/admin/facility-applications', undefined, platformToken);
    const app = list.body.applications.find((a: { facilityId: string }) => a.facilityId === facilityId);
    assert.deepStrictEqual([app.registryCode, app.contact.email], ['SYN-NG-1801', ADMIN_EMAIL]);
    const doc = await call('GET', `/api/admin/facility-applications/${facilityId}/document`, undefined, platformToken);
    assert.strictEqual(Buffer.from(doc.body.document.contentBase64, 'base64').toString(), '%PDF-1.4 synthetic accreditation');
    const luthAdmin = await demoAdmin('admin-fac-luth-001-demo');
    assert.strictEqual((await call('POST', `/api/admin/facilities/${facilityId}/verify`, {}, luthAdmin)).status, 403);

    const verified = await call('POST', `/api/admin/facilities/${facilityId}/verify`, {}, platformToken);
    assert.deepStrictEqual([verified.status, verified.body.status], [200, 'VERIFIED'], JSON.stringify(verified.body));
    const entry = rt.auditManager.getEntries().find((e) => e.action === 'FACILITY_VERIFIED' && e.facilityId === facilityId);
    assert.ok(entry, 'verification is audited');
    assert.strictEqual(entry!.actorId, 'admin-platform-demo');
    assert.strictEqual(rt.billing.get(facilityId)?.status, 'TRIALING', 'verification starts the trial');

    // The invitation (SMS and email) carries a one-time link; opening it sends an OTP to the admin's phone
    const token = inbox(ADMIN_PHONE).join(' ').match(/invite=([A-Za-z0-9_-]+)/)?.[1];
    assert.ok(token, 'invite link sent by SMS');
    assert.ok(inbox(ADMIN_EMAIL).some((m) => m.includes(`invite=${token}`)), 'and by email');
    assert.strictEqual((await call('POST', '/api/facilities/invites/accept', { token: 'not-a-token' })).status, 410);
    const accept = await call('POST', '/api/facilities/invites/accept', { token });
    assert.strictEqual(accept.status, 200, JSON.stringify(accept.body));
    const otp = lastCode(ADMIN_PHONE);
    assert.match(otp, /^\d{6}$/);
    const wrong = String((Number(otp) + 1) % 1_000_000).padStart(6, '0');
    assert.strictEqual((await call('POST', '/api/facilities/invites/verify', { token, otp: wrong })).status, 401);
    const signed = await call('POST', '/api/facilities/invites/verify', { token, otp });
    assert.strictEqual(signed.status, 200, JSON.stringify(signed.body));
    assert.deepStrictEqual([signed.body.account.role, signed.body.account.facilityId, signed.body.account.needsCredentials], ['FACILITY_ADMIN', facilityId, true]);
    assert.strictEqual((await call('POST', '/api/facilities/invites/accept', { token })).status, 410, 'the link is single use');

    // First sign-in: password and authenticator (once), then normal sign-in
    const creds = await call('POST', '/api/admin/credentials', { password: 'synthetic-admin-password-18' }, signed.body.token);
    assert.strictEqual(creds.status, 200, JSON.stringify(creds.body));
    assert.strictEqual((await call('POST', '/api/admin/credentials', { password: 'another-password-18' }, signed.body.token)).status, 409, 'credentials are set once');
    const login = await call('POST', '/api/admin/login', { email: ADMIN_EMAIL, password: 'synthetic-admin-password-18', totp: totpFromUri(creds.body.totpEnrolment.otpauthUri) });
    assert.strictEqual(login.status, 200, JSON.stringify(login.body));
    adminToken = login.body.token;

    // Verified: API clients can now be created
    const client = await call('POST', '/api/admin/facility-api-clients', { name: 'Synthetic EMR' }, adminToken);
    assert.strictEqual(client.status, 200, JSON.stringify(client.body));
  });

  test('A rejected application stays out and cannot get API clients', async () => {
    const reg = await call('POST', '/api/facilities/register', { ...application, name: 'Synthetic Rejected Clinic', type: 'CLINIC', registryCode: 'SYN-NG-1802', adminContact: { name: 'Synthetic Other Admin', email: 'other18@example.org', phone: '+2348000001802' } });
    assert.strictEqual(reg.status, 200, JSON.stringify(reg.body));
    const rejected = await call('POST', `/api/admin/facilities/${reg.body.facilityId}/reject`, { reason: 'Synthetic: document unreadable' }, platformToken);
    assert.deepStrictEqual([rejected.status, rejected.body.status], [200, 'REJECTED']);
    assert.strictEqual((await call('POST', '/api/admin/facility-api-clients', { facilityId: reg.body.facilityId, name: 'Synthetic EMR' }, platformToken)).status, 403);
    assert.strictEqual(inbox('+2348000001802').length, 0, 'no invitation');
  });
});

describe('Facility admin: staff, but never patient records', () => {
  test('The admin approves a PENDING clinician, invites and suspends staff, and reassigns roles', async () => {
    const reg = await call('POST', '/api/clinician/register', { name: 'Dr. Synthetic Eighteen', phone: '+2348000001810', email: 'dr18@example.org', countryCode: 'NG', licenceNumber: 'MDCN/R/18010', facilityRegistryCode: 'SYN-NG-1801', password: clinicianPassword, licenceDocument: pdf('licence') });
    assert.strictEqual(reg.status, 200, JSON.stringify(reg.body));
    clinicianId = reg.body.clinicianId;
    clinicianUri = reg.body.totpEnrolment.otpauthUri;
    const staff = await call('GET', '/api/admin/staff', undefined, adminToken);
    assert.deepStrictEqual(staff.body.clinicians.map((c: { id: string; status: string }) => [c.id, c.status]), [[clinicianId, 'PENDING']]);
    const ok = await call('POST', `/api/admin/clinicians/${clinicianId}/approve`, {}, adminToken);
    assert.deepStrictEqual([ok.status, ok.body.status], [200, 'VERIFIED']);
    assert.ok(rt.auditManager.getEntries().some((e) => e.action === 'CLINICIAN_APPROVED' && e.resourceId === clinicianId));

    // Invite a records officer; reassign them as a nurse; suspend and reinstate
    const inv = await call('POST', '/api/admin/staff/invite', { role: 'RECORDS_OFFICER', name: 'Synthetic Records Officer', email: 'ro18@example.org', phone: '+2348000001811' }, adminToken);
    assert.strictEqual(inv.status, 200, JSON.stringify(inv.body));
    assert.ok(inbox('+2348000001811').some((m) => /invite=/.test(m)));
    assert.strictEqual((await call('POST', '/api/admin/staff/invite', { role: 'PLATFORM_ADMIN', name: 'Synthetic Escalation', email: 'esc18@example.org', phone: '+2348000001812' }, adminToken)).status, 400, 'no platform roles');
    const role = await call('POST', `/api/admin/staff/${inv.body.accountId}/role`, { role: 'NURSE' }, adminToken);
    assert.strictEqual(role.status, 200, JSON.stringify(role.body));
    assert.strictEqual(rt.accounts.get(inv.body.accountId)!.role, 'NURSE');
    assert.strictEqual((await call('POST', `/api/admin/staff/${inv.body.accountId}/suspend`, { reason: 'Synthetic' }, adminToken)).status, 200);
    assert.strictEqual(rt.accounts.get(inv.body.accountId)!.disabled, true);
    assert.strictEqual((await call('POST', `/api/admin/staff/${inv.body.accountId}/reinstate`, {}, adminToken)).status, 200);
    // Another facility's staff are out of reach (404: their existence is not revealed)
    const luthClinician = rt.seedData.clinicians.find((c) => c.facilityId === 'fac-luth-001')!;
    assert.strictEqual((await call('POST', `/api/admin/staff/${luthClinician.id}/suspend`, { reason: 'Synthetic' }, adminToken)).status, 404);
  });

  test('The facility admin gets 403 on every patient record read', async () => {
    const patient = rt.seedData.patients[0].patient;
    const doctor = rt.seedData.clinicians.find((c) => c.facilityId === 'fac-luth-001' && c.status === 'VERIFIED')!;
    const doctorToken = (await call('POST', '/api/clinician/login', { clinicianId: doctor.id, totp: generateTotp(rt.staff.demoTotpSecret(doctor.id)!) })).body.token;
    const bg = await call('POST', '/api/emergency/break-glass', { code: rt.codeByPatient.get(patient.id)!.formattedCode, reason: 'UNCONSCIOUS' }, doctorToken);
    assert.strictEqual(bg.status, 200, JSON.stringify(bg.body));
    for (const token of [adminToken, await demoAdmin('admin-fac-luth-001-demo')]) {
      for (const p of [`/api/patients/${patient.id}`, `/api/patients/${patient.id}/timeline`, `/api/patients/${patient.id}/access-log`,
        `/api/clinician/patients/${patient.id}/record`, `/api/emergency/grants/${bg.body.grantId}/summary`]) {
        assert.strictEqual((await call('GET', p, undefined, token)).status, 403, p);
      }
    }
  });
});

describe('Usage dashboard', () => {
  test('Returns aggregate counts only, with no patient data, and omits what it cannot measure', async () => {
    const luthAdmin = await demoAdmin('admin-fac-luth-001-demo');
    const r = await call('GET', '/api/admin/usage?days=30', undefined, luthAdmin);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const u = r.body;
    for (const k of ['offlineCardScans', 'breakGlassSessions', 'recordsAdded', 'aiDraftsSigned', 'scanToSummarySampleSize']) assert.strictEqual(typeof u[k], 'number', k);
    assert.ok(u.breakGlassSessions >= 1, 'the break-glass session above is counted');
    assert.ok(u.averageSecondsScanToSummary === null || typeof u.averageSecondsScanToSummary === 'number');
    assert.ok(!('duplicateTestsAvoided' in u), 'not estimated');
    assert.deepStrictEqual(u.omitted.map((o: { metric: string }) => o.metric), ['duplicateTestsAvoided']);

    // No PHI keys anywhere in the response, and no patient identifiers or names in its values
    const walk = (v: unknown, at: string) => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { assert.ok(!PHI_KEYS.includes(k.toLowerCase()), `PHI key ${at}.${k}`); walk(x, `${at}.${k}`); }
    };
    walk(u, 'usage');
    const text = JSON.stringify(u);
    for (const { patient } of rt.seedData.patients) {
      assert.ok(!text.includes(patient.id) && !text.includes(patient.lastName), 'no patient id or name');
    }
    // Clinicians cannot see it; a facility admin sees only their own facility
    assert.strictEqual((await call('GET', `/api/admin/usage?facilityId=${facilityId}`, undefined, luthAdmin)).body.facilityId, 'fac-luth-001');
  });
});

describe('Billing never blocks emergencies', () => {
  test('An expired subscription still allows break-glass and offline scan; only admin and analytics are gated', async () => {
    rt.billing.setForTest(facilityId, { status: 'EXPIRED', currentPeriodEnd: new Date(Date.now() - 86_400_000).toISOString() });
    assert.strictEqual(rt.billing.hasAccess(facilityId), false);

    // The facility's clinician: break-glass and an offline scan upload both work
    const kp = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair;
    const publicJwk = await crypto.webcrypto.subtle.exportKey('jwk', kp.publicKey);
    const login = await call('POST', '/api/clinician/login', { clinicianId, password: clinicianPassword, totp: totpFromUri(clinicianUri), devicePublicJwk: publicJwk });
    assert.strictEqual(login.status, 200, JSON.stringify(login.body));
    assert.ok(login.body.pass, 'offline scanner pass issued');
    const patient = rt.seedData.patients[1].patient;
    const bg = await call('POST', '/api/emergency/break-glass', { code: rt.codeByPatient.get(patient.id)!.formattedCode, reason: 'UNCONSCIOUS' }, login.body.token);
    assert.strictEqual(bg.status, 200, JSON.stringify(bg.body));
    assert.strictEqual((await call('GET', `/api/emergency/grants/${bg.body.grantId}/summary`, undefined, login.body.token)).status, 200, 'summary readable');
    const ev = await signScanEvent({ eventId: crypto.randomUUID(), cardSub: patient.id, cardVersion: 1, cardKid: getKid(), reason: 'UNCONSCIOUS', scannedAt: new Date().toISOString(), pass: login.body.pass }, kp.privateKey);
    const up = await call('POST', '/api/emergency/offline-scans', { events: [ev] });
    assert.strictEqual(up.status, 200, JSON.stringify(up.body));
    assert.deepStrictEqual(up.body.results.map((r: { status: string }) => r.status), ['accepted']);

    // Admin and analytics: gated (402). Safety actions (suspension) and billing itself: not gated.
    assert.strictEqual((await call('GET', '/api/admin/usage', undefined, adminToken)).status, 402);
    assert.strictEqual((await call('POST', '/api/admin/facility-api-clients', { name: 'Synthetic EMR 2' }, adminToken)).status, 402);
    assert.strictEqual((await call('POST', '/api/admin/staff/invite', { role: 'NURSE', name: 'Synthetic Nurse', email: 'nurse18@example.org', phone: '+2348000001813' }, adminToken)).status, 402);
    const billing = await call('GET', '/api/admin/billing', undefined, adminToken);
    assert.deepStrictEqual([billing.status, billing.body.access, billing.body.subscription.status], [200, false, 'EXPIRED']);
    assert.ok(billing.body.plans.every((p: { placeholderPrice: boolean }) => p.placeholderPrice), 'prices are marked as placeholders');
    assert.strictEqual((await call('GET', '/api/admin/staff', undefined, adminToken)).status, 200);
  });

  test('Patients are never charged: there is no patient plan and patient routes ignore billing', async () => {
    const plans = loadPlans();
    assert.ok(plans.plans.every((p) => !/patient/i.test(`${p.id} ${p.name}`)));
    const patient = rt.seedData.patients[0].patient;
    assert.strictEqual((await call('GET', `/api/patients/${patient.id}/timeline`)).status, 200, 'own records (demo mode: no sign-in)');
  });
});

describe('Payment webhooks', () => {
  const PAYSTACK_SECRET = 'sk_test_synthetic_phase18_key';
  const WEBHOOK_SECRET = 'whsec_synthetic_phase18_secret';
  const MPESA_SECRET = 'synthetic-callback-secret-0123456789abcdef';
  const initialized: Array<Record<string, any>> = [];
  const fakePaystack = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    initialized.push(body);
    return new Response(JSON.stringify({ status: true, message: 'Authorization URL created', data: { authorization_url: 'https://checkout.paystack.com/synthetic', access_code: 'synthetic', reference: body.reference } }), { status: 200 });
  }) as typeof fetch;

  test('Live keys are refused: test and sandbox modes only', () => {
    assert.throws(() => new PaystackProvider({ secretKey: 'sk_live_synthetic' }), /test-mode/);
    assert.throws(() => new MpesaDarajaProvider({ env: 'production', consumerKey: 'k', consumerSecret: 's', shortCode: '174379', passKey: 'p', callbackSecret: MPESA_SECRET }), /sandbox/);
  });

  test('Webhooks with an invalid signature are rejected and audited; a valid one renews the subscription', async () => {
    rt.billingProviders.set('NG', new PaystackProvider({ secretKey: PAYSTACK_SECRET, webhookSecret: WEBHOOK_SECRET, fetch: fakePaystack }));
    rt.billingProviders.set('KE', new MpesaDarajaProvider({ env: 'sandbox', consumerKey: 'synthetic', consumerSecret: 'synthetic', shortCode: '174379', passKey: 'synthetic', callbackSecret: MPESA_SECRET }));
    const sub = await call('POST', '/api/admin/billing/subscribe', { plan: 'clinic' }, adminToken);
    assert.strictEqual(sub.status, 200, JSON.stringify(sub.body));
    assert.strictEqual(sub.body.checkoutUrl, 'https://checkout.paystack.com/synthetic');
    assert.strictEqual(initialized[0].amount, String(loadPlans().plans[0].prices.NG));
    const reference = sub.body.providerRef;

    const event = JSON.stringify({ event: 'charge.success', data: { id: 1801, reference, amount: loadPlans().plans[0].prices.NG, currency: 'NGN', status: 'success' } });
    const t = Math.floor(Date.now() / 1000);
    const sign = (secret: string, body: string, ts = t) => crypto.createHmac('sha512', secret).update(`${ts}.${body}`).digest('hex');
    const rejectedBefore = rt.auditManager.getEntries().filter((e) => e.action === 'BILLING_WEBHOOK_REJECTED').length;

    const bad = [
      {},                                                                                   // no signature
      { 'Paystack-Signature': `t=${t},v1=${sign('whsec_wrong', event)}` },                  // wrong secret
      { 'Paystack-Signature': `t=${t - 3600},v1=${sign(WEBHOOK_SECRET, event, t - 3600)}` }, // replayed (outside the time window)
      { 'x-paystack-signature': crypto.createHmac('sha512', 'sk_test_wrong').update(event).digest('hex') }, // legacy header, wrong key
    ];
    for (const headers of bad) assert.strictEqual((await raw('/api/billing/webhooks/paystack', event, headers)).status, 401, JSON.stringify(headers));
    // A tampered body with a signature made for the original
    assert.strictEqual((await raw('/api/billing/webhooks/paystack', event.replace('"success"}', '"success","x":1}'), { 'Paystack-Signature': `t=${t},v1=${sign(WEBHOOK_SECRET, event)}` })).status, 401);
    // M-Pesa: no secret, or the wrong one, in the callback path
    const stk = JSON.stringify({ Body: { stkCallback: { MerchantRequestID: 'synthetic', CheckoutRequestID: 'ws_CO_synthetic', ResultCode: 0, ResultDesc: 'Synthetic' } } });
    assert.strictEqual((await raw('/api/billing/webhooks/mpesa', stk)).status, 401);
    assert.strictEqual((await raw('/api/billing/webhooks/mpesa/wrong-secret-0123456789abcdefghijklmnop', stk)).status, 401);
    assert.strictEqual(rt.auditManager.getEntries().filter((e) => e.action === 'BILLING_WEBHOOK_REJECTED').length, rejectedBefore + 7, 'each rejection audited');
    assert.notStrictEqual(rt.billing.get(facilityId)?.status, 'ACTIVE', 'nothing changed');

    // Valid signatures: Paystack activates the subscription; M-Pesa with the right path secret is accepted (unknown request: no change)
    const ok = await raw('/api/billing/webhooks/paystack', event, { 'Paystack-Signature': `t=${t},v1=${sign(WEBHOOK_SECRET, event)}` });
    assert.deepStrictEqual([ok.status, ok.body.applied, ok.body.status], [200, true, 'ACTIVE'], JSON.stringify(ok.body));
    assert.strictEqual(rt.billing.hasAccess(facilityId), true);
    assert.strictEqual((await call('GET', '/api/admin/usage', undefined, adminToken)).status, 200, 'analytics back after payment');
    const again = await raw('/api/billing/webhooks/paystack', event, { 'Paystack-Signature': `t=${t},v1=${sign(WEBHOOK_SECRET, event)}` });
    assert.deepStrictEqual([again.status, again.body.applied], [200, false], 'a repeated event is not applied twice');
    const mp = await raw(`/api/billing/webhooks/mpesa/${MPESA_SECRET}`, stk);
    assert.deepStrictEqual([mp.status, mp.body.applied], [200, false]);
  });
});
