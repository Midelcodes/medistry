// Phase 19: the triage validation banner, the document reference check (also run in CI), and the patient-rights
// endpoints the compliance documents describe (FHIR export, dispute review).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { createRuntime } from '../src/lib/runtime.ts';
import { createMemoryPersistence } from '../src/lib/data/memory/persistence.ts';
import { createPortalApi } from '../src/lib/site/portalApi.ts';
import { generateTotp } from '../src/lib/auth/security.ts';
// Dependency-free MCP modules (the root suite runs before the MCP install in CI).
import { VALIDATION_BANNER, triageValidated, validationBanner, startupBanner, withValidationBanner, reportBannerLines } from '../mcp/src/validation.js';
import { triage } from '../mcp/src/tews.js';
import { checkDocs, checkFile, collectRoutes, DOC_DIRS } from '../scripts/check-doc-paths.mjs';

const VITALS = { mobility: 'walking', respiratoryRate: 16, heartRate: 80, systolicBP: 120, temperatureC: 37, avpu: 'alert', trauma: false };

describe('Triage validation banner', () => {
  test('Shown until CLINICAL_VALIDATION_SIGNED=1 exactly', () => {
    assert.strictEqual(VALIDATION_BANNER, 'Triage scoring not clinically validated');
    for (const v of [undefined, '', '0', 'true', 'yes', '01', ' 2 ']) {
      const env = v === undefined ? {} : { CLINICAL_VALIDATION_SIGNED: v };
      assert.strictEqual(triageValidated(env), false, String(v));
      assert.strictEqual(validationBanner(env), VALIDATION_BANNER);
      assert.match(startupBanner(env)!, /^WARNING: Triage scoring not clinically validated\./);
      assert.strictEqual(withValidationBanner(triage(VITALS), env).validationBanner, VALIDATION_BANNER);
      assert.match(reportBannerLines(env)[0], /Triage scoring not clinically validated/);
    }
    for (const v of ['1', ' 1 ']) {
      const env = { CLINICAL_VALIDATION_SIGNED: v };
      assert.strictEqual(triageValidated(env), true);
      assert.strictEqual(validationBanner(env), null);
      assert.strictEqual(startupBanner(env), null);
      assert.deepStrictEqual(withValidationBanner(triage(VITALS), env), triage(VITALS), 'result unchanged once signed');
      assert.deepStrictEqual(reportBannerLines(env), []);
    }
  });

  test('The banner sits first in the result, and the score itself does not depend on it', () => {
    const r = withValidationBanner(triage(VITALS), {});
    assert.strictEqual(Object.keys(r)[0], 'validationBanner');
    assert.strictEqual(r.category, triage(VITALS).category);
  });

  test('Every place that shows a triage score uses the banner (MCP server start-up and tools, handover report, agent)', () => {
    const read = (f: string) => fs.readFileSync(new URL(`../mcp/src/${f}`, import.meta.url), 'utf8');
    const server = read('server.js');
    assert.match(server, /const banner = startupBanner\(\);\s*if \(banner\) console\.error\(banner\);/);
    assert.match(server, /ok\(withValidationBanner\(\{ age, \.\.\.triage\(/);
    assert.match(server, /ok\(withValidationBanner\(detectDeterioration\(/);
    assert.match(read('orchestrator.js'), /\.\.\.reportBannerLines\(\)/);
    assert.match(read('agent.js'), /validationBanner\(\)/);
  });

  test('A value outside every band is refused instead of scoring GREEN (clinical safety fix)', () => {
    assert.throws(() => triage({ ...VITALS, respiratoryRate: 8.5 }), /Cannot score TEWS/);
  });
});

describe('Document references', () => {
  test('Every path and endpoint named in docs/compliance and docs/clinical exists', () => {
    const { files, problems } = checkDocs();
    for (const f of ['DPIA_TEMPLATE_NG.md', 'DPIA_TEMPLATE_KE.md', 'RECORDS_OF_PROCESSING.md', 'DATA_SUBJECT_RIGHTS.md', 'BREACH_RESPONSE.md', 'REGULATOR_ACTIONS.md']) {
      assert.ok(files.includes(`docs/compliance/${f}`), f);
    }
    assert.ok(files.includes('docs/clinical/CLINICAL_SAFETY_CASE.md') && files.includes('docs/clinical/TEWS_VALIDATION_CHECKLIST.md'));
    assert.deepStrictEqual(problems, []);
    assert.deepStrictEqual(DOC_DIRS, ['docs/compliance', 'docs/clinical']);
  });

  test('The checker catches a missing file, a missing endpoint, a wrong method and a broken link', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medistry-docs-'));
    const doc = path.join(dir, 'BAD.md');
    fs.writeFileSync(doc, [
      'Real: `src/lib/audit/hashChain.ts`, GET `/api/patients/:id/export`, POST `/api/admin/anomalies/:id/review`.',
      'Fake module: `src/lib/compliance/magic.ts`.',
      'Fake endpoint: GET `/api/patients/:id/erase`.',
      'Wrong method: DELETE `/api/patients/:id/timeline`.',
      'Broken link: [x](./nowhere.md).',
    ].join('\n'));
    const problems = checkFile(doc, collectRoutes());
    assert.strictEqual(problems.length, 4, problems.join('\n'));
    assert.match(problems.join('\n'), /path not found: src\/lib\/compliance\/magic\.ts/);
    assert.match(problems.join('\n'), /endpoint not found: GET \/api\/patients\/:id\/erase/);
    assert.match(problems.join('\n'), /not for DELETE/);
    assert.match(problems.join('\n'), /link target not found/);
  });

  test('The CLI exits 0 on the real documents, and CI runs it', () => {
    const r = spawnSync(process.execPath, ['scripts/check-doc-paths.mjs'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'), /node scripts\/check-doc-paths\.mjs/);
  });

  test('No document claims legal compliance', () => {
    for (const dir of ['docs/compliance', 'docs/clinical']) {
      for (const f of fs.readdirSync(dir)) {
        const text = fs.readFileSync(path.join(dir, f), 'utf8');
        assert.doesNotMatch(text, /\b(is|are|fully) (NDPA[- ])?compliant\b|\bcomplies with\b|\bcertified\b/i, f);
      }
    }
  });
});

describe('Patient rights endpoints', () => {
  let base = '';
  let server: http.Server;
  let rt: Awaited<ReturnType<typeof createRuntime>>;
  const call = async (method: string, p: string, body?: unknown, token?: string) => {
    const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) as any };
  };
  const adminToken = async (id: string) => (await call('POST', '/api/admin/login', { adminId: id, totp: generateTotp(rt.staff.demoTotpSecret(id)!) })).body.token;
  before(async () => {
    rt = await createRuntime(createMemoryPersistence());
    const api = createPortalApi({ ...rt, notifications: rt.consoleProvider, offlineCards: rt.offlineCardStore, dataDir: path.join(os.tmpdir(), 'medistry-phase19s') });
    server = http.createServer(async (req, res) => { if (!(await api(req, res, new URL(req.url || '/', 'http://localhost')))) { res.writeHead(404); res.end('{}'); } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => { server.close(); });

  test('Export: the patient gets a FHIR R4 Bundle of their own records; audited; staff get 403', async () => {
    const patient = rt.seedData.patients[0].patient;
    const r = await call('GET', `/api/patients/${patient.id}/export`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual([r.body.resourceType, r.body.type], ['Bundle', 'document']);
    assert.ok(r.body.total > 0);
    assert.strictEqual(r.body.entry.length, r.body.total);
    assert.ok(r.body.entry.every((e: any) => e.resource.subject?.reference === `Patient/${patient.id}` || e.resource.patient?.reference === `Patient/${patient.id}`), 'only this patient');
    assert.ok(rt.auditManager.getEntries().some((e) => e.action === 'PATIENT_EXPORTED_RECORD' && e.subjectId === patient.id && e.resourceId === r.body.id));
    assert.strictEqual((await call('GET', `/api/patients/${patient.id}/export`, undefined, await adminToken('admin-fac-luth-001-demo'))).status, 403);
  });

  test('Complaints: a patient disputes an access; a platform admin reviews and resolves it', async () => {
    const patient = rt.seedData.patients[1].patient;
    const c = rt.seedData.clinicians[0];
    await rt.emergencyEngine.initiateBreakGlass({ patient, emergencyCode: rt.codeByPatient.get(patient.id)!.formattedCode, actor: { userId: c.userId, role: 'DOCTOR', clinicianId: c.id, facilityId: c.facilityId, isVerifiedClinician: true }, treatingDoctorName: c.fullName, facilityId: c.facilityId, facilityName: 'Synthetic', reason: 'UNCONSCIOUS' });
    const entry = rt.auditManager.getEntries().find((e) => e.action === 'EMERGENCY_BREAK_GLASS_INITIATED' && e.subjectId === patient.id)!;
    const d = await call('POST', `/api/patients/${patient.id}/disputes`, { auditLogId: entry.id, reason: 'Synthetic: I was not in hospital' });
    assert.strictEqual(d.status, 200, JSON.stringify(d.body));
    const platform = await adminToken('admin-platform-demo');
    assert.strictEqual((await call('GET', '/api/admin/disputes', undefined, await adminToken('admin-fac-luth-001-demo'))).status, 403);
    const list = await call('GET', '/api/admin/disputes?status=PENDING_REVIEW', undefined, platform);
    assert.ok(list.body.disputes.some((t: any) => t.ticketId === d.body.ticket.ticketId));
    const ticket = d.body.ticket.ticketId;
    assert.strictEqual((await call('POST', `/api/admin/disputes/${ticket}/resolve`, { resolution: 'IGNORED', notes: 'Synthetic' }, platform)).status, 400);
    assert.strictEqual((await call('POST', `/api/admin/disputes/${ticket}/resolve`, { resolution: 'RESOLVED_BREACH', notes: 'x' }, platform)).status, 400, 'a note is required');
    assert.strictEqual((await call('POST', '/api/admin/disputes/no-such-ticket/resolve', { resolution: 'RESOLVED_VALID', notes: 'Synthetic note' }, platform)).status, 404);
    const ok = await call('POST', `/api/admin/disputes/${ticket}/resolve`, { resolution: 'RESOLVED_BREACH', notes: 'Synthetic: start breach response' }, platform);
    assert.deepStrictEqual([ok.status, ok.body.dispute.status], [200, 'RESOLVED_BREACH']);
    assert.ok(rt.auditManager.getEntries().some((e) => e.action === 'PLATFORM_ADMIN_RESOLVED_DISPUTE' && e.actorId === 'admin-platform-demo'));
  });
});
