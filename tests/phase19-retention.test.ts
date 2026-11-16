// Phase 19: the retention job is report-only. It lists what each configured rule WOULD archive, deletes nothing,
// and never selects clinical records.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { createRuntime, type Runtime } from '../src/lib/runtime.ts';
import { createMemoryPersistence } from '../src/lib/data/memory/persistence.ts';
import { createPortalApi } from '../src/lib/site/portalApi.ts';
import { generateTotp } from '../src/lib/auth/security.ts';
import { retentionReport, retentionConfigFromEnv, RETENTION_RULES } from '../src/lib/ops/retention.ts';

const DAY = 86_400_000;
const info = { ipAddress: '127.0.0.1', userAgent: 'test' };
const pdf = { filename: 'accreditation.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('%PDF-1.4 synthetic').toString('base64') };
const ALL_SET = Object.fromEntries(RETENTION_RULES.map((r) => [r.env, 1])); // 1 year or 1 day each

/** Everything the report could touch, so "deletes nothing" can be checked exactly. */
function snapshot(rt: Runtime) {
  return JSON.stringify({
    audit: rt.auditManager.getEntries().map((e) => e.currentHash),
    scans: rt.offlineScans.allEvents().map((e) => e.id),
    deliveries: rt.deliveries.all().map((d) => d.id),
    intake: rt.intake.retentionView().map((s) => s.id),
    onboarding: rt.onboarding.retentionView(),
    flags: rt.anomalyAgent.retentionView(),
    records: rt.seedData.patients.map((p) => rt.clinicalStore.getLatestFinalRecords(p.patient.id).length),
    sms: rt.consoleProvider.sentSmsLogs.length,
  });
}

describe('Retention report (report only)', () => {
  let rt: Runtime;
  before(async () => {
    rt = await createRuntime(createMemoryPersistence());
    const platform = rt.accounts.get('admin-platform-demo')!;
    // One verified facility (an unused invitation) and one rejected application; an SMS delivery; a reviewed flag.
    const contact = (n: number) => ({ name: 'Synthetic Admin', email: `ret${n}@example.org`, phone: `+23480000019${n}0` });
    const a = await rt.onboarding.register({ name: 'Synthetic Retention A', type: 'HOSPITAL', countryCode: 'NG', registryCode: 'SYN-RET-1', adminContact: contact(1), accreditationDocument: pdf }, info);
    await rt.onboarding.review(platform, a.facilityId, 'verify', undefined, 'https://medistry.test', info);
    const b = await rt.onboarding.register({ name: 'Synthetic Retention B', type: 'CLINIC', countryCode: 'NG', registryCode: 'SYN-RET-2', adminContact: contact(2), accreditationDocument: pdf }, info);
    await rt.onboarding.review(platform, b.facilityId, 'reject', 'Synthetic', 'https://medistry.test', info);
    const c = rt.seedData.clinicians[0];
    for (const { patient: p } of rt.seedData.patients.slice(0, 2)) {
      await rt.emergencyEngine.initiateBreakGlass({ patient: p, emergencyCode: rt.codeByPatient.get(p.id)!.formattedCode, actor: { userId: c.userId, role: 'DOCTOR', clinicianId: c.id, facilityId: c.facilityId, isVerifiedClinician: true }, treatingDoctorName: c.fullName, facilityId: c.facilityId, facilityName: 'Synthetic', reason: 'UNCONSCIOUS' });
    }
    const [flag] = rt.anomalyAgent.run(Date.now() + 48 * 3_600_000); // two "no encounter" flags; one is reviewed
    rt.anomalyAgent.review(platform, flag.id, 'dismiss', 'Synthetic review', info);
  });

  test('Nothing configured: every rule reports "not configured" and selects nothing', () => {
    const r = retentionReport(rt, retentionConfigFromEnv({}));
    assert.strictEqual(r.mode, 'REPORT_ONLY');
    assert.strictEqual(r.deletesNothing, true);
    assert.deepStrictEqual(r.rules.map((x) => x.category), RETENTION_RULES.map((x) => x.category));
    for (const rule of r.rules) {
      assert.deepStrictEqual([rule.configured, rule.wouldArchive, rule.ids.length], [false, 0, 0], rule.category);
      assert.match(rule.todo!, /confirmed by counsel/);
    }
  });

  test('Only positive numbers configure a rule', () => {
    const c = retentionConfigFromEnv({ RETENTION_AUDIT_YEARS: '7', RETENTION_DELIVERY_DAYS: '0', RETENTION_INTAKE_DAYS: '-5', RETENTION_INVITE_DAYS: 'abc' });
    assert.deepStrictEqual([c.RETENTION_AUDIT_YEARS, c.RETENTION_DELIVERY_DAYS, c.RETENTION_INTAKE_DAYS, c.RETENTION_INVITE_DAYS], [7, null, null, null]);
  });

  test('Today, with every period set: only what is already past its period (none of it is yet)', () => {
    const r = retentionReport(rt, ALL_SET);
    const by = Object.fromEntries(r.rules.map((x) => [x.category, x]));
    assert.strictEqual(by.auditEntries.wouldArchive, 0);
    assert.ok(by.auditEntries.held > 0);
    assert.strictEqual(by.staffInvites.held, 0, 'the invitation is neither used nor expired');
    assert.strictEqual(by.rejectedFacilityApplications.held, 1);
    assert.strictEqual(by.rejectedFacilityApplications.wouldArchive, 0, 'rejected today: not yet past one day');
  });

  test('Two years on: reports exactly what each rule would archive', () => {
    const later = Date.now() + 2 * 365 * DAY;
    const r = retentionReport(rt, ALL_SET, later);
    const by = Object.fromEntries(r.rules.map((x) => [x.category, x]));
    assert.strictEqual(by.auditEntries.wouldArchive, rt.auditManager.getEntries().length);
    const total = rt.auditManager.getEntries().length;
    assert.strictEqual(by.auditEntries.ids.length, Math.min(100, total), 'ids are capped at 100');
    assert.strictEqual(by.auditEntries.idsTruncated, total > 100);
    assert.deepStrictEqual(by.auditEntries.ids.slice(0, 3), rt.auditManager.getEntries().slice(0, 3).map((e) => e.id), 'oldest first');
    assert.match(by.auditEntries.note!, /signed checkpoint/);
    assert.strictEqual(by.smsDeliveryRecords.wouldArchive, rt.deliveries.all().length);
    assert.ok(by.smsDeliveryRecords.wouldArchive > 0);
    assert.strictEqual(by.staffInvites.wouldArchive, 1, 'the invitation has expired by then');
    assert.strictEqual(by.rejectedFacilityApplications.wouldArchive, 1, 'only the rejected application, not the verified one');
    assert.strictEqual(by.reviewedAnomalyFlags.wouldArchive, 1, 'only the reviewed flag');
    assert.strictEqual(by.reviewedAnomalyFlags.held, 1);
    assert.ok(rt.anomalyAgent.retentionView().length > 1, 'open flags are never selected');
    assert.ok(by.auditEntries.oldestSelected! <= by.auditEntries.cutoff!);
    // Clinical records are never a category
    assert.ok(!r.rules.some((x) => /clinical|record(s)?$/i.test(x.category) && x.category !== 'smsDeliveryRecords'));
    assert.match(r.neverSelected[0].reason, /never hard-deleted/);
    // The report has no names, phone numbers or emails
    const text = JSON.stringify(r);
    assert.ok(!/\+234\d+|@example\.org|Synthetic Admin/.test(text));
  });

  test('Running the report deletes and changes nothing; the audit chain still verifies', () => {
    const before = snapshot(rt);
    for (const now of [Date.now(), Date.now() + 10 * 365 * DAY]) retentionReport(rt, ALL_SET, now);
    assert.strictEqual(snapshot(rt), before);
    assert.strictEqual(rt.auditManager.verifyChain().valid, true);
  });

  test('The module has no code path that removes data', () => {
    const src = fs.readFileSync(new URL('../src/lib/ops/retention.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.doesNotMatch(src, /\.delete\(|\.clear\(|\.splice\(|deleteMany|\.wipe\(|\.pop\(|\.shift\(|unlink/);
  });
});

describe('Retention report: endpoint and script', () => {
  let rt: Runtime;
  let base = '';
  let server: http.Server;
  before(async () => {
    rt = await createRuntime(createMemoryPersistence());
    const api = createPortalApi({ ...rt, notifications: rt.consoleProvider, offlineCards: rt.offlineCardStore, dataDir: path.join(os.tmpdir(), 'medistry-phase19r') });
    server = http.createServer(async (req, res) => { if (!(await api(req, res, new URL(req.url || '/', 'http://localhost')))) { res.writeHead(404); res.end('{}'); } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => { server.close(); });

  test('GET /api/admin/retention-report: platform admins only, audited, nothing removed', async () => {
    const token = async (id: string) => (await (await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminId: id, totp: generateTotp(rt.staff.demoTotpSecret(id)!) }) })).json()).token;
    const get = async (t: string) => fetch(`${base}/api/admin/retention-report`, { headers: { Authorization: `Bearer ${t}` } });
    assert.strictEqual((await get(await token('admin-fac-luth-001-demo'))).status, 403);
    const entries = rt.auditManager.getEntries().length;
    const r = await get(await token('admin-platform-demo'));
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).mode, 'REPORT_ONLY');
    assert.ok(rt.auditManager.getEntries().some((e) => e.action === 'RETENTION_REPORT_GENERATED'));
    assert.ok(rt.auditManager.getEntries().length > entries, 'entries are only ever added');
  });

  test('scripts/retention-report.ts prints the report and exits 0', () => {
    const r = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/retention-report.ts'], {
      env: { ...process.env, STORAGE: 'memory', RETENTION_AUDIT_YEARS: '6' }, encoding: 'utf8',
    });
    assert.strictEqual(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    assert.strictEqual(report.mode, 'REPORT_ONLY');
    assert.deepStrictEqual(report.rules.find((x: { category: string }) => x.category === 'auditEntries').period, '6 years');
  });
});
