import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import QRCode from 'qrcode';
import {
  generateCardQr,
  generateQrSvg,
  createQrSymbol,
  buildCardQrText,
  generateWalletCardSvg,
  generateWristbandSvg,
  DEFAULT_CONFIG,
} from '../src/lib/code/deliverables.ts';
import { renderPrintableOfflineCard, buildOfflineCardBundle, maskEmergencyCode } from '../src/lib/emergency/offlineCard.ts';
import { OfflineCardStore } from '../src/lib/emergency/offlineCardStore.ts';
import { verifyCompactJws, getPublicJwks } from '../src/lib/crypto/cardKeys.ts';
import { auditHtmlForWcag21AA } from '../src/lib/security/accessibilityAudit.ts';
import { createPatientRecord, type PatientEntity } from '../src/lib/patient/profile.ts';
import { generateSeedData } from '../prisma/seed.ts';

const BASE = 'https://demo.medistry.example';
const CODE = 'K7QM-4T9X-2HDP-8W2';

function buildPatient(allergy = 'Penicillin', contactName = 'Primary Contact'): PatientEntity {
  const p = createPatientRecord(
    { firstName: 'Test', lastName: 'Synthetic', dateOfBirth: '1990-01-01', gender: 'female' },
    {
      bloodGroup: 'O_POSITIVE',
      genotype: 'SS',
      allergies: [{ substance: allergy, category: 'drug', reaction: 'Anaphylaxis', severity: 'severe' }],
      chronicConditions: ['Opt-in Condition Example'],
      activeMedications: [{ medicationName: 'Opt-in Medicine Example', dose: '5mg', route: 'oral', sinceDate: '2024-01-01' }],
      emergencyContacts: [{ id: 'c1', name: contactName, relationship: 'Sibling', phone: '+234 800 000 0001', priority: 1 }],
      advanceDirectiveDnr: true,
      organDonor: false,
    },
    { userId: 'u-synthetic', countryCode: 'NG' }
  );
  return p;
}

/** Reads the dark modules back out of our SVG path ("M{x} {y}h1v1h-1z" per module). */
function svgModules(svg: string): Set<string> {
  const d = svg.match(/<path fill="#000000" d="([^"]*)"/)?.[1] || '';
  return new Set([...d.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map((m) => `${m[1]},${m[2]}`));
}

describe('1. QR content and rendering', () => {
  const store = new OfflineCardStore();

  test('QR SVG and PNG are non-empty and the encoded text starts with APP_URL/s#', async () => {
    const issued = store.issue(buildPatient());
    const qr = await generateCardQr(issued.token, `${BASE}/`);
    assert.ok(qr.text.startsWith(`${BASE}/s#`), qr.text.slice(0, 40));
    assert.ok(!qr.text.includes('/e/'), 'must not reuse the online code gate');

    assert.match(qr.svg, /^<svg [^>]*viewBox="0 0 \d+ \d+"/);
    assert.ok(svgModules(qr.svg).size > 100);
    assert.match(qr.pngDataUrl, /^data:image\/png;base64,/);
    const png = Buffer.from(qr.pngDataUrl.split(',')[1], 'base64');
    assert.deepStrictEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    // The SVG draws exactly the modules the QR library computed for this text (level M).
    const ref = QRCode.create(qr.text, { errorCorrectionLevel: 'M' });
    const expected = new Set<string>();
    for (let y = 0; y < ref.modules.size; y++) for (let x = 0; x < ref.modules.size; x++) if (ref.modules.get(y, x)) expected.add(`${x + 4},${y + 4}`);
    assert.deepStrictEqual(svgModules(qr.svg), expected);
    assert.strictEqual(qr.version, ref.version);
  });

  test('The token extracted from the QR text verifies with the Phase 1 verifier', async () => {
    const issued = store.issue(buildPatient());
    const qr = await generateCardQr(issued.token, BASE);
    const token = qr.text.slice(qr.text.indexOf('#') + 1);
    const result = verifyCompactJws(token, getPublicJwks());
    assert.strictEqual(result.valid, true, result.error);
    assert.strictEqual(result.payload?.e.bg, 'O+');
  });

  test('An 1800-character token fits in QR version 40 or lower at level M; oversized content fails clearly', () => {
    const token = `${'a'.repeat(600)}.${'b'.repeat(1113)}.${'c'.repeat(86)}`;
    assert.strictEqual(token.length, 1801);
    const text = buildCardQrText(token, BASE);
    const { version } = createQrSymbol(text);
    assert.ok(version <= 40, `version ${version}`);
    assert.throws(() => createQrSymbol('x'.repeat(2400)), /too large .* version 40 QR code at error correction level M/);
    assert.throws(() => buildCardQrText('not a token', BASE), /compact JWS/);
  });

  test('Wallet card and wristband now carry real QR codes of the online gate URL', () => {
    const cfg = { ...DEFAULT_CONFIG, baseUrl: BASE };
    const wallet = generateWalletCardSvg(CODE, 'Test Synthetic', undefined, cfg);
    const band = generateWristbandSvg(CODE, cfg);
    const gate = `${BASE}/e/${CODE}`;
    const ref = QRCode.create(gate, { errorCorrectionLevel: 'M' });
    let dark = 0;
    for (let y = 0; y < ref.modules.size; y++) for (let x = 0; x < ref.modules.size; x++) if (ref.modules.get(y, x)) dark++;
    for (const svg of [wallet, band]) {
      assert.ok(!/Mock QR|>SCAN</.test(svg), 'no fake QR pattern left');
      assert.strictEqual(svgModules(svg).size, dark);
    }
    assert.strictEqual(generateQrSvg(gate), generateQrSvg(gate), 'deterministic');
  });
});

describe('2. Printable card', () => {
  async function bundleFor(patient: PatientEntity) {
    const issued = new OfflineCardStore().issue(patient);
    return buildOfflineCardBundle(issued, { baseUrl: BASE, formattedCode: CODE });
  }
  const textOf = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  test('Card HTML has the core fields as plain text and passes the accessibility audit', async () => {
    const p = buildPatient();
    p.cardConditions = [...p.chronicConditions];
    p.cardMedicationIds = p.activeMedications.map((m) => m.id);
    const card = await bundleFor(p);
    const text = textOf(card.cardHtml);

    for (const s of ['EMERGENCY MEDICAL CARD', 'Clinicians: scan with Medistry. Works offline.', 'O+', 'O POSITIVE', 'SS',
      'Penicillin', 'Anaphylaxis', 'DNR ON FILE', 'Primary Contact', '+234 800 000 0001', 'K7QM-****-****-*W2', 'Card v1']) {
      assert.ok(text.includes(s), `card text should include ${s}`);
    }
    assert.ok(text.includes(`Issued ${card.issuedAt.slice(0, 10)}`));
    assert.ok(text.includes(`Expires ${card.expiresAt.slice(0, 10)}`));
    assert.ok(!text.includes(CODE), 'full emergency code is never printed');

    // Opt-in items are in the QR payload but never printed on the card.
    assert.deepStrictEqual(card.payload.e.cond, ['Opt-in Condition Example']);
    assert.ok(!card.cardHtml.includes('Opt-in Condition Example'));
    assert.ok(!card.cardHtml.includes('Opt-in Medicine Example'));
    assert.ok(!card.cardHtml.includes(card.token), 'token appears only inside the QR, not as text');

    // Print layout: ID-1 size, no margins, front and back as separate pages.
    assert.match(card.cardHtml, /@page \{ size: 85\.6mm 54mm; margin: 0; \}/);
    assert.match(card.cardHtml, /width: 85\.6mm; height: 54mm/);
    assert.match(card.cardHtml, /aria-label="Card front"/);
    assert.match(card.cardHtml, /aria-label="Card back"/);
    assert.match(card.cardHtml, /<svg aria-hidden="true"[^>]*viewBox="0 0 32 32"/, 'inline Medistry logo');

    const audit = auditHtmlForWcag21AA(card.cardHtml);
    assert.strictEqual(audit.passed, true, `Violations: ${audit.violations.join('; ')}`);
    assert.strictEqual(audit.score, 100);
  });

  test('An injected allergy name like <script> is escaped in the card HTML', async () => {
    const card = await bundleFor(buildPatient('<script>alert("x")</script>', '"><img src=x onerror=alert(1)>'));
    assert.ok(!card.cardHtml.includes('<script>alert'), 'raw script tag must not appear');
    assert.ok(card.cardHtml.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'));
    assert.ok(!card.cardHtml.includes('<img src=x'));
    assert.ok(card.cardHtml.includes('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;'));
    assert.strictEqual((card.cardHtml.match(/<script/gi) || []).length, 0, 'the card page has no script elements at all');
  });

  test('Masked code keeps the first group and the last two characters', () => {
    assert.strictEqual(maskEmergencyCode(CODE), 'K7QM-****-****-*W2');
    assert.strictEqual(maskEmergencyCode(undefined), 'not set');
    assert.ok(renderPrintableOfflineCard({
      qrSvg: '<svg></svg>', bloodGroup: 'unknown', genotype: 'unknown', allergies: [], dnr: false,
      maskedCode: 'not set', issuedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-07-01T00:00:00Z',
    }).includes('No severe allergies recorded'));
  });
});

describe('3. Card API', () => {
  const seedPatientId = generateSeedData().patients[0].patient.id; // deterministic seed ids
  let demo: ChildProcess;
  let locked: ChildProcess;
  const DEMO_PORT = 37000 + Math.floor(Math.random() * 1000);
  const LOCKED_PORT = DEMO_PORT + 1000;

  async function start(port: number, extraEnv: Record<string, string>) {
    const child = spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], {
      env: { ...process.env, STORAGE: 'memory', PORT: String(port), APP_URL: BASE, ...extraEnv }, stdio: 'ignore',
    });
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`http://localhost:${port}/api/health`)).ok) return child; } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('server did not start');
  }

  before(async () => {
    [demo, locked] = await Promise.all([start(DEMO_PORT, { DEMO_MODE: '1' }), start(LOCKED_PORT, { DEMO_MODE: '0' })]);
  });
  after(() => { demo?.kill(); locked?.kill(); });

  test('GET returns token, QR PNG, card HTML, version and expiry; GET again reuses the card; POST reissues', async () => {
    const url = `http://localhost:${DEMO_PORT}/api/patients/${seedPatientId}/offline-card`;
    const first = await (await fetch(url)).json();
    for (const k of ['token', 'qrPngDataUrl', 'cardHtml', 'cardVersion', 'expiresAt', 'warnings']) assert.ok(k in first, k);
    assert.strictEqual(first.cardVersion, 1);
    assert.match(first.qrPngDataUrl, /^data:image\/png;base64,/);
    assert.ok(first.cardHtml.includes('EMERGENCY MEDICAL CARD'));

    const { keys } = await (await fetch(`http://localhost:${DEMO_PORT}/.well-known/medistry-keys.json`)).json();
    assert.strictEqual(verifyCompactJws(first.token, keys).valid, true);

    const again = await (await fetch(url)).json();
    assert.strictEqual(again.cardVersion, 1);
    assert.strictEqual(again.token, first.token);
    assert.strictEqual(again.reused, true);

    const reissued = await (await fetch(url, { method: 'POST' })).json();
    assert.strictEqual(reissued.cardVersion, 2);
    assert.notStrictEqual(reissued.token, first.token);

    const { cards } = await (await fetch(`${url}s`)).json();
    assert.strictEqual(cards.length, 2);
    assert.strictEqual(cards[0].supersededById, cards[1].id);

    // The printable page serves the same current card.
    const page = await fetch(`http://localhost:${DEMO_PORT}/emergency/offline-card?patientId=${seedPatientId}`);
    assert.strictEqual(page.status, 200);
    assert.ok((await page.text()).includes('Card v2'));
  });

  test('Issuance writes OFFLINE_CARD_ISSUED to the audit chain and the chain stays valid', async () => {
    const before = (await (await fetch(`http://localhost:${DEMO_PORT}/api/stats`)).json()).auditEntries;
    await fetch(`http://localhost:${DEMO_PORT}/api/patients/${seedPatientId}/offline-card`, { method: 'POST' });
    const stats = await (await fetch(`http://localhost:${DEMO_PORT}/api/stats`)).json();
    assert.ok(stats.auditEntries > before);
    assert.strictEqual(stats.auditChainValid, true);
  });

  test('With DEMO_MODE=0 and no session, the card endpoints return 401 (404 for the demo generators)', async () => {
    // Phase 12: patient routes need a patient session outside demo mode (was a blanket 403 before sign-in existed).
    const get = await fetch(`http://localhost:${LOCKED_PORT}/api/patients/${seedPatientId}/offline-card`);
    assert.strictEqual(get.status, 401);
    const post = await fetch(`http://localhost:${LOCKED_PORT}/api/patients/${seedPatientId}/offline-card`, { method: 'POST' });
    assert.strictEqual(post.status, 401);
    for (const path of ['/emergency/offline-card', '/emergency/wallet-card', '/emergency/wristband']) {
      assert.strictEqual((await fetch(`http://localhost:${LOCKED_PORT}${path}?patientId=${seedPatientId}`)).status, 404, path);
    }
  });
});
