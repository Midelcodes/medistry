// Phase 13: patients receive alerts, including on feature phones. Africa's Talking SMS provider (HTTP mocked),
// delivery records and the delivery-report webhook, SMS templates without clinical detail, and the USSD menu.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

process.env.USSD_CALLBACK_SECRET = 'u'.repeat(40);
process.env.SMS_WEBHOOK_SECRET = 'w'.repeat(40);

const { createRuntime } = await import('../src/lib/runtime.ts');
const { createMemoryPersistence } = await import('../src/lib/data/memory/persistence.ts');
const { createPortalApi } = await import('../src/lib/site/portalApi.ts');
const { AfricasTalkingNotificationProvider, AFRICASTALKING_SMS_URLS } = await import('../src/lib/notifications/africasTalking.ts');
const { NotificationDeliveryStore } = await import('../src/lib/notifications/deliveries.ts');
const { ConsoleNotificationProvider, NotificationDispatcher } = await import('../src/lib/notifications/dispatcher.ts');
const { SMS_TEMPLATES, SMS_TEMPLATE_IDS, renderSms } = await import('../src/lib/i18n/translations.ts');
const { USSD_MAX_CHARS } = await import('../src/lib/ussd/ussdService.ts');

const config = { username: 'sandbox', apiKey: 'test-api-key-not-real', senderId: 'MEDISTRY', env: 'sandbox' as const, acceptedStatusCodes: [101] };

/** A fetch stand-in that records calls and answers from a script of responses. */
function mockFetch(responses: Array<{ status: number; body?: unknown } | 'network-error'>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next === 'network-error') throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'TypeError' });
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const accepted = (messageId: string) => ({ status: 201, body: { SMSMessageData: { Message: 'Sent to 1/1', Recipients: [{ statusCode: 101, number: '+254711000001', status: 'Success', cost: 'KES 0.8000', messageId }] } } });

describe("Africa's Talking SMS provider", () => {
  test('Sends through the provider API (form-encoded, apiKey header) and records the delivery without the number', async () => {
    const deliveries = new NotificationDeliveryStore();
    const { fn, calls } = mockFetch([accepted('ATXid_abc123')]);
    const provider = new AfricasTalkingNotificationProvider({ config, deliveries, fallback: new ConsoleNotificationProvider(), fetch: fn, sleep: async () => {} });
    assert.strictEqual(await provider.sendSms('+254711000001', 'Synthetic message', { templateId: 'access_alert' }), true);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, AFRICASTALKING_SMS_URLS.sandbox);
    assert.strictEqual(calls[0].url, 'https://api.sandbox.africastalking.com/version1/messaging');
    assert.strictEqual(calls[0].init.method, 'POST');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.deepStrictEqual([headers.apiKey, headers.Accept, headers['Content-Type']], ['test-api-key-not-real', 'application/json', 'application/x-www-form-urlencoded']);
    const body = new URLSearchParams(String(calls[0].init.body));
    assert.deepStrictEqual(Object.fromEntries(body), { username: 'sandbox', to: '+254711000001', message: 'Synthetic message', from: 'MEDISTRY' });
    const [d] = deliveries.all();
    assert.deepStrictEqual([d.status, d.providerMessageId, d.attempts, d.templateId, d.toLast3], ['SENT', 'ATXid_abc123', 1, 'access_alert', '001']);
    assert.match(d.toHash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(d).includes('711000001') && !JSON.stringify(d).includes('Synthetic message'), 'no number or text in the record');
  });

  test('A failure is retried 3 times with exponential backoff, then the dispatcher falls back to email', async () => {
    const deliveries = new NotificationDeliveryStore();
    const consoleProvider = new ConsoleNotificationProvider();
    const delays: number[] = [];
    const { fn, calls } = mockFetch([{ status: 500 }, 'network-error', { status: 503 }]);
    const provider = new AfricasTalkingNotificationProvider({ config, deliveries, fallback: consoleProvider, fetch: fn, sleep: async (ms) => { delays.push(ms); } });
    const dispatcher = new NotificationDispatcher(provider);
    const results = await dispatcher.dispatchEmergencyBreakGlassAlerts(
      { id: 'patient-synthetic', fullName: 'Synthetic Patient', phone: '+254711000002', email: 'patient@example.org', emergencyContacts: [] },
      { doctorName: 'Dr. Synthetic', facilityName: 'Synthetic Hospital', reason: 'UNCONSCIOUS', timestamp: new Date().toISOString() },
    );
    assert.strictEqual(calls.length, 3, 'three attempts');
    assert.deepStrictEqual(delays, [1000, 2000], 'exponential backoff');
    assert.deepStrictEqual(results.map((r) => `${r.channel}:${r.status}`), ['SMS:FAILED', 'EMAIL:FALLBACK_DELIVERED', 'PUSH:FALLBACK_DELIVERED']);
    assert.strictEqual(consoleProvider.sentEmailLogs[0].to, 'patient@example.org');
    assert.ok(!consoleProvider.sentEmailLogs[0].body.includes('UNCONSCIOUS'), 'the fallback email carries no clinical detail either');
    const [d] = deliveries.all();
    assert.deepStrictEqual([d.status, d.attempts], ['FAILED', 3]);
    assert.ok(d.lastError && !d.lastError.includes('711000002'));
  });

  test('A refusal that cannot succeed (invalid number) is not retried', async () => {
    const deliveries = new NotificationDeliveryStore();
    const { fn, calls } = mockFetch([{ status: 201, body: { SMSMessageData: { Recipients: [{ statusCode: 403, number: '+254', status: 'InvalidPhoneNumber', messageId: 'None' }] } } }]);
    const provider = new AfricasTalkingNotificationProvider({ config, deliveries, fallback: new ConsoleNotificationProvider(), fetch: fn, sleep: async () => {} });
    await assert.rejects(provider.sendSms('+254711000003', 'x', { templateId: 'sign_in_code' }), /provider status 403 InvalidPhoneNumber/);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(deliveries.all()[0].status, 'FAILED');
  });
});

// ---------- runtime + in-process portal for templates, USSD and the webhook ----------
const rt = await createRuntime(createMemoryPersistence());
const api = createPortalApi({ ...rt, notifications: rt.consoleProvider, offlineCards: rt.offlineCardStore, dataDir: path.join(os.tmpdir(), 'medistry-phase13') });
let base = '';
const server = http.createServer(async (req, res) => {
  if (!(await api(req, res, new URL(req.url || '/', 'http://localhost')))) { res.writeHead(404); res.end('{}'); }
});
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

const info = { ipAddress: '127.0.0.1', userAgent: 'test' };
const patient = rt.seedData.patients[0].patient;
const PHONE = '+2348000000801';
const PIN = '4826';

/** Every clinical value a seeded patient has, in the forms it could appear in. */
function clinicalStrings(): string[] {
  const out = new Set<string>();
  for (const { patient: p } of rt.seedData.patients) {
    const bg = p.bloodGroup;
    if (bg !== 'UNKNOWN') for (const v of [bg, bg.replace('_', ' '), bg.replace('_POSITIVE', '+').replace('_NEGATIVE', '-')]) out.add(v);
    for (const c of p.chronicConditions) out.add(c);
    for (const m of p.activeMedications) out.add(m.medicationName);
    for (const a of p.allergies) out.add(a.substance);
  }
  return [...out];
}
function assertNoClinical(text: string, where: string) {
  for (const c of clinicalStrings()) {
    // Short tokens (blood groups such as "A-") only count as whole, case-sensitive tokens ("ga-agwu" is Igbo, not "A-").
    const found = c.length <= 3
      ? new RegExp(`(?<![A-Za-z0-9])${c.replace(/[+-]/g, '\\$&')}(?![A-Za-z0-9])`).test(text)
      : text.toLowerCase().includes(c.toLowerCase());
    assert.ok(!found, `${where} must not contain "${c}"`);
  }
  assert.doesNotMatch(text, /\b(SS|AS|AA|SC|AC)\b/, `${where} must not contain a genotype`);
  assert.doesNotMatch(text, /blood|genotype|allerg|unconscious|life.threatening/i, `${where} must not name clinical fields or a break-glass reason`);
}

describe('SMS templates carry no clinical detail', () => {
  test('No template, in any language, contains blood group, genotype, conditions, medications or allergies', () => {
    const vars = { doctor: 'Dr. Robert Caldwell', facility: 'Lagos University Teaching Hospital (LUTH)', patient: 'Amara Okonkwo', code: '123456', age: 18, date: '2099-01-01' };
    for (const locale of Object.keys(SMS_TEMPLATES)) {
      for (const id of SMS_TEMPLATE_IDS) {
        const sms = renderSms(id, locale, vars);
        assertNoClinical(sms, `${locale}/${id}`);
        assert.ok(!/\{\w+\}/.test(sms), `${locale}/${id} fills every placeholder`);
        if (id !== 'access_alert' && id !== 'contact_alert') assert.ok(sms.length <= 160, `${locale}/${id} is ${sms.length} characters`);
      }
    }
    process.env.USSD_SERVICE_CODE = '*384*55#';
    try {
      const alert = renderSms('access_alert', 'en', vars);
      assert.strictEqual(alert, 'Your Medistry record was accessed by Dr. Robert Caldwell at Lagos University Teaching Hospital (LUTH). Open the app or dial *384*55# to review or dispute.');
      assert.ok(alert.length <= 160);
    } finally {
      delete process.env.USSD_SERVICE_CODE;
    }
  });

  test('A real break-glass alerts the patient on their own phone, and no SMS sent contains clinical detail', async () => {
    rt.patientAuth.linkPatient(patient, PHONE, { ...info, adminId: 'admin-platform-demo' });
    const doctor = rt.seedData.clinicians.find((c) => c.facilityId === patient.primaryFacilityId)!;
    await rt.emergencyEngine.initiateBreakGlass({
      patient, emergencyCode: rt.codeByPatient.get(patient.id)!.formattedCode,
      actor: { userId: doctor.userId, role: 'DOCTOR', clinicianId: doctor.id, facilityId: doctor.facilityId, isVerifiedClinician: true },
      treatingDoctorName: doctor.fullName, facilityId: doctor.facilityId, facilityName: 'Synthetic ER', reason: 'UNCONSCIOUS', reasonDetails: 'Synthetic detail',
    });
    const toPatient = rt.consoleProvider.sentSmsLogs.filter((s) => s.to === PHONE);
    assert.strictEqual(toPatient.length, 1, 'the patient gets the SMS, not only their emergency contacts');
    assert.match(toPatient[0].message, new RegExp(`accessed by ${doctor.fullName.replace('.', '\\.')} at Synthetic ER`));
    for (const s of rt.consoleProvider.sentSmsLogs) assertNoClinical(s.message, 'sent SMS');
    assert.ok(rt.deliveries.all().some((d) => d.templateId === 'access_alert' && d.toLast3 === '801'), 'delivery record for the patient SMS');
  });
});

async function ussd(text: string, opts: { phone?: string; secret?: string } = {}) {
  const body = new URLSearchParams({ sessionId: 'ATUid_synthetic', serviceCode: '*384*55#', phoneNumber: opts.phone || PHONE, text });
  const r = await fetch(`${base}/api/ussd/${opts.secret ?? process.env.USSD_CALLBACK_SECRET}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const reply = await r.text();
  if (r.status === 200) {
    assert.match(r.headers.get('content-type') || '', /^text\/plain/);
    assert.match(reply, /^(CON|END) /);
    assert.ok(reply.length <= USSD_MAX_CHARS, `screen of ${reply.length} characters: ${reply}`);
  }
  return { status: r.status, reply };
}
const auditActions = () => rt.auditManager.getEntries().filter((e) => e.subjectId === patient.id).map((e) => e.action);

describe('USSD channel', () => {
  before(async () => {
    // The patient signs in to the app (SMS code) and sets a USSD PIN there.
    await fetch(`${base}/api/auth/patient/otp/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: PHONE }) });
    const code = rt.consoleProvider.sentSmsLogs.filter((s) => s.to === PHONE).at(-1)!.message.match(/\b(\d{6})\b/)![1];
    const { token } = await (await fetch(`${base}/api/auth/patient/otp/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: PHONE, otp: code }) })).json();
    const weak = await fetch(`${base}/api/auth/patient/ussd-pin`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ pin: '1234' }) });
    assert.strictEqual(weak.status, 400, 'obvious PINs are refused');
    const set = await fetch(`${base}/api/auth/patient/ussd-pin`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ pin: PIN }) });
    assert.strictEqual(set.status, 200);
    assert.ok(rt.accounts.byPhoneNumber(PHONE)!.ussdPinHash!.startsWith('scrypt$N=32768,r=8,p=1$'), 'PIN stored as an scrypt hash');
  });

  test('The callback needs the shared secret; an unknown number is told it is not linked', async () => {
    assert.strictEqual((await ussd('', { secret: 'x'.repeat(40) })).status, 401);
    const unknown = await ussd('', { phone: '+2348000000899' });
    assert.match(unknown.reply, /^END This number is not linked/);
  });

  test('Correct PIN: menu, then the emergency summary (blood group, genotype, allergies only) under 182 characters', async () => {
    assert.match((await ussd('')).reply, /^CON Medistry\nEnter your 4-digit PIN:/);
    const menu = await ussd(PIN);
    assert.strictEqual(menu.reply, 'CON 1. My emergency summary\n2. Recent access to my record\n3. Dispute last access\n4. Lock my emergency card');
    const summary = await ussd(`${PIN}*1`);
    assert.match(summary.reply, /^END Blood group: /);
    assert.ok(summary.reply.includes(`Genotype: ${patient.genotype}`));
    for (const a of patient.allergies) assert.ok(summary.reply.includes(a.substance.slice(0, 10)) || summary.reply.endsWith('...'));
    for (const c of patient.chronicConditions) assert.ok(!summary.reply.includes(c), 'no conditions');
    for (const m of patient.activeMedications) assert.ok(!summary.reply.includes(m.medicationName), 'no medications');
    const recent = await ussd(`${PIN}*2`);
    assert.match(recent.reply, /^END 1\. /);
    assert.ok(auditActions().includes('USSD_SUMMARY_VIEWED') && auditActions().includes('USSD_ACCESS_LOG_VIEWED'));
  });

  test('Dispute last access creates a dispute record and an audit entry', async () => {
    const confirm = await ussd(`${PIN}*3`);
    assert.match(confirm.reply, /^CON Dispute access by .+\n1\. Yes\n2\. No$/);
    const before = rt.accessLogManager.getOpenDisputes().length;
    const done = await ussd(`${PIN}*3*1`);
    assert.match(done.reply, /^END Dispute opened \(ref [0-9A-F]{8}\)/);
    const disputes = rt.accessLogManager.getOpenDisputes();
    assert.strictEqual(disputes.length, before + 1);
    const ticket = disputes.at(-1)!;
    assert.deepStrictEqual([ticket.patientId, ticket.disputeReason], [patient.id, 'Disputed by the patient by USSD']);
    const entry = rt.auditManager.getEntries().find((e) => e.action === 'USSD_DISPUTE_OPENED')!;
    assert.strictEqual(entry.subjectId, patient.id);
    assert.ok(entry.reason!.includes(ticket.ticketId));
    assert.ok(!JSON.stringify(rt.auditManager.getEntries()).includes(PHONE) && !entry.reason!.includes(PIN), 'no phone number or PIN in the audit log');
    assert.match((await ussd(`${PIN}*3`)).reply, /already disputed/);
  });

  test('Lock my emergency card revokes the card', async () => {
    rt.offlineCardStore.issue(patient);
    const version = rt.offlineCardStore.getCurrent(patient.id)!.version;
    assert.match((await ussd(`${PIN}*4`)).reply, /^CON Lock your emergency card\?/);
    assert.match((await ussd(`${PIN}*4*1`)).reply, /^END Your emergency card is locked/);
    assert.strictEqual(rt.offlineCardStore.getCurrent(patient.id), undefined);
    assert.ok(rt.offlineCardStore.list(patient.id).find((c) => c.version === version)!.revokedAt, 'revoked');
    assert.ok(auditActions().includes('USSD_CARD_LOCKED'));
    assert.match((await ussd(`${PIN}*4`)).reply, /no active emergency card/);
  });

  test('Three wrong PINs lock USSD (even the right PIN then fails) until a new PIN is set in the app', async () => {
    assert.match((await ussd('1111')).reply, /^END Wrong PIN\. 2 attempt\(s\) left\./);
    assert.match((await ussd('2222')).reply, /^END Wrong PIN\. 1 attempt\(s\) left\./);
    assert.match((await ussd('3333*1')).reply, /^END Wrong PIN\. USSD access is now locked/);
    assert.match((await ussd(`${PIN}*1`)).reply, /^END USSD access is locked/);
    assert.ok(auditActions().includes('USSD_PIN_LOCKED'));
    await rt.ussd.setPin(rt.accounts.byPhoneNumber(PHONE)!, '5937', info);
    assert.match((await ussd('5937')).reply, /^CON 1\. My emergency summary/, 'a new PIN unlocks');
  });
});

describe('Delivery-report webhook', () => {
  const post = (p: string, form: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(form) });

  test('A bad or missing secret is rejected; a good one updates the delivery record', async () => {
    const d = rt.deliveries.create('+2348000000802', 'access_alert', 'africastalking');
    rt.deliveries.update(d, { status: 'SENT', providerMessageId: 'ATXid_synthetic1' });
    assert.strictEqual((await post(`/api/webhooks/sms/delivery/${'z'.repeat(40)}`, { id: 'ATXid_synthetic1', status: 'Success' })).status, 401);
    assert.strictEqual((await post('/api/webhooks/sms/delivery', { id: 'ATXid_synthetic1', status: 'Success' })).status, 401);
    assert.strictEqual((await post('/api/webhooks/sms/delivery', { id: 'ATXid_synthetic1', status: 'Success' }, { 'X-Medistry-Webhook-Secret': 'w'.repeat(39) })).status, 401);
    assert.strictEqual(d.status, 'SENT', 'unchanged after rejected calls');

    const ok = await post(`/api/webhooks/sms/delivery/${process.env.SMS_WEBHOOK_SECRET}`, { id: 'ATXid_synthetic1', status: 'Success', phoneNumber: '+2348000000802', networkCode: '62120' });
    assert.deepStrictEqual([ok.status, (await ok.json()).matched], [200, true]);
    assert.deepStrictEqual([d.status, d.providerStatus], ['DELIVERED', 'Success']);

    const e = rt.deliveries.create('+2348000000803', 'contact_alert', 'africastalking');
    rt.deliveries.update(e, { status: 'SENT', providerMessageId: 'ATXid_synthetic2' });
    await post('/api/webhooks/sms/delivery', { id: 'ATXid_synthetic2', status: 'Rejected', failureReason: 'InvalidPhoneNumber' }, { 'X-Medistry-Webhook-Secret': process.env.SMS_WEBHOOK_SECRET! });
    assert.deepStrictEqual([e.status, e.lastError], ['FAILED', 'delivery report: InvalidPhoneNumber']);
    const unknown = await post(`/api/webhooks/sms/delivery/${process.env.SMS_WEBHOOK_SECRET}`, { id: 'ATXid_unknown', status: 'Success' });
    assert.deepStrictEqual([unknown.status, (await unknown.json()).matched], [200, false]);
  });
});
