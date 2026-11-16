// Phase 14: safe to run with real data. clamd malware scanning (mock clamd over TCP), magic-byte checks and
// metadata stripping, the KeyProvider with field and card key rotation, log redaction, deployment config and
// health, and the CSP.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { startMockClamd, type MockClamd } from './mockClamd.ts';
import {
  ClamdVirusScannerAdapter, TestPatternScannerAdapter, createVirusScanner, ScannerUnavailableError, EICAR_TEST_STRING,
} from '../src/lib/clinical/virusScanners.ts';
import { SecureDocumentManager, UPLOAD_MAX_MB } from '../src/lib/clinical/fileUpload.ts';
import { detectFileType, assertSafeFileType } from '../src/lib/clinical/fileSafety.ts';
import { EnvKeyProvider } from '../src/lib/crypto/keyProvider.ts';
import { loadCardKeyStore, verifyCompactJws, jwkThumbprint } from '../src/lib/crypto/cardKeys.ts';
import { encryptField, decryptField, reencryptField, fieldKeyVersionOf } from '../src/lib/patient/profile.ts';
import { redact, log, requestIdFrom } from '../src/lib/ops/logger.ts';
import { assertDeploymentConfig } from '../src/lib/security/config.ts';
import { getSecurityHttpHeaders } from '../src/lib/security/rateLimiter.ts';

/** A TCP port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const pdf = (text = 'synthetic') => Buffer.from(`%PDF-1.4\n${text}\n%%EOF`);
const upload = (m: SecureDocumentManager, buffer: Buffer, filename = 'doc.pdf', mimeType = 'application/pdf') =>
  m.processUpload({ filename, mimeType, buffer, title: 'Synthetic', category: 'referral-letter' }, 'patient-x', 'clinician-x', 'facility-x');

describe('clamd malware scanning (mock clamd over TCP)', () => {
  let clamd: MockClamd;
  before(async () => { clamd = await startMockClamd(); });
  after(async () => { await clamd.close(); });

  test('Clean file: INSTREAM answers OK (also for a file larger than one chunk)', async () => {
    const scanner = new ClamdVirusScannerAdapter({ host: '127.0.0.1', port: clamd.port, chunkSize: 1024 });
    assert.deepStrictEqual(await scanner.scanBuffer(pdf('x'.repeat(10_000))), { clean: true });
    assert.strictEqual(await scanner.ping(), true);
    const m = new SecureDocumentManager(scanner);
    assert.strictEqual((await upload(m, pdf())).documentReference.resourceType, 'DocumentReference');
  });

  test('Infected file: clamd reports FOUND and the upload is rejected', async () => {
    const scanner = new ClamdVirusScannerAdapter({ host: '127.0.0.1', port: clamd.port });
    assert.deepStrictEqual(await scanner.scanBuffer(pdf(EICAR_TEST_STRING)), { clean: false, threatName: 'Eicar-Signature' });
    await assert.rejects(upload(new SecureDocumentManager(scanner), pdf(EICAR_TEST_STRING)), /Virus or malicious payload detected \(Eicar-Signature\)/);
  });

  test('Unreachable clamd: production (DEMO_MODE=0) rejects the upload; it never falls back', async () => {
    const port = await closedPort();
    const prod = createVirusScanner({ DEMO_MODE: '0', CLAMD_HOST: '127.0.0.1', CLAMD_PORT: String(port) });
    assert.ok(prod instanceof ClamdVirusScannerAdapter);
    await assert.rejects(prod.scanBuffer(pdf()), (err: unknown) => err instanceof ScannerUnavailableError && /unreachable/.test((err as Error).message));
    await assert.rejects(upload(new SecureDocumentManager(prod), pdf()), /Malware scanner unavailable .* Upload rejected/);
    assert.strictEqual(await (prod as ClamdVirusScannerAdapter).ping(500), false);
    // DEMO_MODE=0 without CLAMD_HOST still means clamd (localhost:3310), never the test patterns.
    assert.strictEqual(createVirusScanner({ DEMO_MODE: '0' }).name, 'clamd (localhost:3310)');
  });

  test('The string matcher is TestPatternScannerAdapter, used only for demo and tests', async (t) => {
    assert.ok(createVirusScanner({}) instanceof TestPatternScannerAdapter);
    assert.match(new TestPatternScannerAdapter().name, /not antivirus/);
    // Demo with an unreachable CLAMD_HOST: falls back to the test patterns, with a warning.
    const warn = t.mock.method(console, 'warn', () => {});
    const demo = createVirusScanner({ CLAMD_HOST: '127.0.0.1', CLAMD_PORT: String(await closedPort()) });
    assert.deepStrictEqual(await demo.scanBuffer(pdf()), { clean: true });
    assert.strictEqual(warn.mock.callCount(), 1);
  });
});

describe('Upload content checks', () => {
  const m = new SecureDocumentManager(new TestPatternScannerAdapter());

  test('An EXE renamed .pdf is rejected by the magic-byte check', async () => {
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64), Buffer.from('This program cannot be run in DOS mode')]);
    assert.strictEqual(detectFileType(exe), null);
    await assert.rejects(upload(m, exe, 'discharge.pdf'), /not a PDF, PNG or JPEG/);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    await assert.rejects(upload(m, png, 'scan.pdf', 'application/pdf'), /does not match the declared type/);
    assert.throws(() => assertSafeFileType(pdf(), 'application/pdf', 'invoice.exe'), /extension \.exe does not match/);
    assert.strictEqual(UPLOAD_MAX_MB, 10);
  });

  test('JPEG EXIF (APP1) and PNG text chunks are removed before storage', async () => {
    const seg = (marker: number, body: Buffer) => { const h = Buffer.from([0xff, marker, 0, 0]); h.writeUInt16BE(body.length + 2, 2); return Buffer.concat([h, body]); };
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from('JFIF\0synthetic')), seg(0xe1, Buffer.from('Exif\0\0GPSLatitude 6.5244 Lagos; Camera owner Amara')),
      seg(0xfe, Buffer.from('comment: synthetic name')), Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6, 0x11, 0x22, 0xff, 0xd9]),
    ]);
    const r = await upload(m, jpeg, 'photo.jpg', 'image/jpeg');
    const stored = Buffer.from(decryptField(r.encryptedFilePayload), 'base64');
    assert.strictEqual(detectFileType(stored), 'image/jpeg');
    for (const leak of ['GPSLatitude', 'Lagos', 'Amara', 'synthetic name']) assert.ok(!stored.toString('latin1').includes(leak), `${leak} removed`);
    assert.ok(stored.toString('latin1').includes('JFIF'), 'other segments kept');
    assert.ok(stored.subarray(-2).equals(Buffer.from([0xff, 0xd9])), 'image data kept');

    const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)]); };
    const pngFile = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', Buffer.alloc(13)), chunk('tEXt', Buffer.from('Author\0Synthetic Person')), chunk('IDAT', Buffer.alloc(4)), chunk('IEND', Buffer.alloc(0))]);
    const p = Buffer.from(decryptField((await upload(m, pngFile, 'scan.png', 'image/png')).encryptedFilePayload), 'base64');
    assert.ok(!p.toString('latin1').includes('Synthetic Person') && p.toString('latin1').includes('IDAT'));
  });
});

describe('Key management and rotation', () => {
  const k1 = crypto.randomBytes(32).toString('hex');
  const k2 = crypto.randomBytes(32).toString('hex');

  test('Ciphertext under an old key version still decrypts after rotation; new writes use the new version', () => {
    const before = new EnvKeyProvider({ FIELD_ENCRYPTION_KEY: k1 });
    const old = encryptField('Synthetic NIN 12345678901', before);
    assert.match(old, /^v1:/);
    const rotated = new EnvKeyProvider({ FIELD_ENCRYPTION_KEY: k2, FIELD_ENCRYPTION_KEY_VERSION: '2', FIELD_ENCRYPTION_PREVIOUS_KEYS: `1:${k1}` });
    assert.strictEqual(decryptField(old, rotated), 'Synthetic NIN 12345678901', 'old version still decrypts');
    const fresh = encryptField('new value', rotated);
    assert.strictEqual(fieldKeyVersionOf(fresh), 2, 'new writes use the new version');
    assert.strictEqual(decryptField(fresh, rotated), 'new value');
    const legacy = old.replace(/^v1:/, ''); // written before versioning existed
    assert.strictEqual(decryptField(legacy, rotated), 'Synthetic NIN 12345678901', 'unprefixed ciphertexts are version 1');
    const re = reencryptField(old, rotated);
    assert.deepStrictEqual([fieldKeyVersionOf(re), decryptField(re, rotated)], [2, 'Synthetic NIN 12345678901']);
    assert.strictEqual(reencryptField(fresh, rotated), fresh, 'already current: unchanged');
    assert.deepStrictEqual(rotated.getFieldKeyVersions(), [2, 1]);
    // Once the old key is removed, its ciphertexts can no longer be read (so rotate before removing it).
    assert.throws(() => decryptField(old, new EnvKeyProvider({ FIELD_ENCRYPTION_KEY: k2, FIELD_ENCRYPTION_KEY_VERSION: '2' })), /No field encryption key for version 1/);
  });

  test('Card key rotation: new cards get the new kid; old public keys stay in the JWKS until their keep-until date', () => {
    const gen = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const [current, previous, retired] = [gen(), gen(), gen()];
    const spki = (k: crypto.KeyObject) => k.export({ format: 'der', type: 'spki' }).toString('base64');
    const pkcs8 = (k: crypto.KeyObject) => k.export({ format: 'pem', type: 'pkcs8' }).toString();
    const env = {
      OFFLINE_CARD_PRIVATE_KEY: pkcs8(current.privateKey),
      OFFLINE_CARD_PREVIOUS_PUBLIC_KEYS: `${spki(previous.publicKey)}@2099-01-01T00:00:00Z,${spki(retired.publicKey)}@2020-01-01`,
    };
    const provider = new EnvKeyProvider(env);
    const kidOf = (k: crypto.KeyObject) => { const { kty, crv, x, y } = k.export({ format: 'jwk' }); return jwkThumbprint({ kty, crv, x, y }); };
    const kids = provider.getCardJwks().map((k) => k.kid);
    assert.deepStrictEqual(kids, [kidOf(current.publicKey), kidOf(previous.publicKey)], 'expired key dropped, unexpired kept');
    const token = provider.signCard({ sub: 'p', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 });
    assert.strictEqual(JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()).kid, kidOf(current.publicKey), 'new cards: new kid');
    // A card signed earlier with the previous key still verifies; after its keep-until date it would not.
    const oldCard = loadCardKeyStore({ OFFLINE_CARD_PRIVATE_KEY: pkcs8(previous.privateKey) }).signCompactJws({ sub: 'p', iat: 1, exp: 4102444700 });
    assert.strictEqual(verifyCompactJws(oldCard, provider.getCardJwks(), 1000).valid, true);
    assert.strictEqual(verifyCompactJws(oldCard, provider.getCardJwks(4102444800 + 1), 1000).valid, false);
  });
});

describe('Structured logs and redaction', () => {
  test('Redaction removes phone numbers, NIN, emergency codes, JWS tokens, emails and named fields', (t) => {
    const jws = `${Buffer.from('{"alg":"ES256","kid":"abc"}').toString('base64url')}.${Buffer.from('{"sub":"patient-1","exp":1}').toString('base64url')}.${crypto.randomBytes(64).toString('base64url')}`;
    const input = {
      requestId: '3f2a9c10-1b2c-4d3e-a5f6-123456789abc', path: '/e/K7QM-4T9X-2HDP-8W2', status: 200, at: '2026-11-16T10:00:00.000Z',
      error: `SMS to +234 801 234 5678 failed; NIN 12345678901; code K7QM-4T9X-2HDP-8W2; token ${jws}; mail amara@example.org; Bearer abc.def`,
      fullName: 'Amara Okonkwo', phoneNumber: '+2348012345678', nested: { nin: '12345678901', note: 'free text with a name' },
    };
    const out = JSON.stringify(redact(input));
    for (const leak of ['801 234 5678', '2348012345678', '12345678901', 'K7QM-4T9X-2HDP-8W2', jws, jws.split('.')[2], 'amara@example.org', 'Amara', 'Okonkwo', 'free text', 'abc.def']) {
      assert.ok(!out.includes(leak), `must not contain ${leak.slice(0, 20)}`);
    }
    for (const kept of ['3f2a9c10-1b2c-4d3e-a5f6-123456789abc', '2026-11-16T10:00:00.000Z', '"status":200', '[REDACTED_NUMBER]', '[REDACTED_CODE]', '[REDACTED_TOKEN]']) {
      assert.ok(out.includes(kept), `keeps ${kept}`);
    }
    const lines: string[] = [];
    t.mock.method(console, 'log', (l: string) => { lines.push(l); });
    log('info', 'sms_failed', { requestId: 'req-abcdefgh', to: '+2348012345678', error: 'number +2348012345678 unreachable' });
    const line = JSON.parse(lines[0]);
    assert.deepStrictEqual([line.level, line.event, line.requestId, line.to], ['info', 'sms_failed', 'req-abcdefgh', '[REDACTED]']);
    assert.ok(!lines[0].includes('8012345678'));
    assert.strictEqual(requestIdFrom('req-12345678'), 'req-12345678');
    assert.match(requestIdFrom('bad id with spaces'), /^[0-9a-f-]{36}$/);
  });
});

describe('Deployment config, startup, health and CSP', () => {
  const strong = () => crypto.randomBytes(32).toString('hex');
  const cardKey = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const prodEnv = () => ({ ...process.env, STORAGE: 'memory', NODE_ENV: 'production', DEMO_MODE: '0', JWT_SECRET: strong(), FIELD_ENCRYPTION_KEY: strong(), OFFLINE_CARD_PRIVATE_KEY: cardKey, CLAMD_HOST: '127.0.0.1', CLAMD_PORT: '1' });
  function startServer(env: NodeJS.ProcessEnv) {
    const out: string[] = [];
    const child = spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', (d) => out.push(String(d)));
    child.stderr!.on('data', (d) => out.push(String(d)));
    const exited = new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
    return { child, out, exited };
  }

  test('assertDeploymentConfig needs DEPLOYMENT_COUNTRY and DEPLOYMENT_REGION only with DEMO_MODE=0', () => {
    assert.doesNotThrow(() => assertDeploymentConfig({}));
    assert.throws(() => assertDeploymentConfig({ DEMO_MODE: '0', DEPLOYMENT_REGION: 'lagos-1' }), /DEPLOYMENT_COUNTRY/);
    assert.throws(() => assertDeploymentConfig({ DEMO_MODE: '0', DEPLOYMENT_COUNTRY: 'NG' }), /DEPLOYMENT_REGION/);
    assert.doesNotThrow(() => assertDeploymentConfig({ DEMO_MODE: '0', DEPLOYMENT_COUNTRY: 'NG', DEPLOYMENT_REGION: 'lagos-1' }));
  });

  test('Startup with DEMO_MODE=0 and NODE_ENV=production fails when DEPLOYMENT_COUNTRY is missing', async () => {
    const env = { ...prodEnv(), DEPLOYMENT_REGION: 'lagos-1' };
    delete (env as Record<string, unknown>).DEPLOYMENT_COUNTRY;
    const s = startServer(env);
    const code = await Promise.race([s.exited, new Promise<number>((r) => setTimeout(() => { s.child.kill(); r(-1); }, 20000))]);
    assert.strictEqual(code, 1);
    assert.match(s.out.join(''), /Startup failed: DEMO_MODE=0 needs DEPLOYMENT_COUNTRY/);
  });

  test('With both set: startup logs country, region and storage (no secrets); health has version, uptime, storage and clamd; CSP and headers', async () => {
    const port = 45500 + Math.floor(Math.random() * 400);
    const env = { ...prodEnv(), PORT: String(port), DEPLOYMENT_COUNTRY: 'NG', DEPLOYMENT_REGION: 'lagos-1' };
    const s = startServer(env);
    const base = `http://localhost:${port}`;
    try {
      for (let i = 0; i < 100; i++) {
        try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* starting */ }
        await new Promise((r) => setTimeout(r, 200));
      }
      const startup = s.out.join('').split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((l) => l?.event === 'startup');
      assert.deepStrictEqual([startup.country, startup.region, startup.storage, startup.keyProvider, startup.demoMode], ['NG', 'lagos-1', 'memory', 'env', false]);
      const logs = s.out.join('');
      for (const secret of [env.JWT_SECRET, env.FIELD_ENCRYPTION_KEY, cardKey.split('\n')[1]]) assert.ok(!logs.includes(secret), 'no secret in the logs');

      const r = await fetch(`${base}/api/health`, { headers: { 'X-Request-Id': 'probe-12345678' } });
      assert.strictEqual(r.headers.get('x-request-id'), 'probe-12345678');
      const h = await r.json();
      assert.strictEqual(typeof h.version, 'string');
      assert.ok(Number.isInteger(h.uptimeSeconds));
      assert.deepStrictEqual([h.storage.mode, h.storage.status], ['memory', 'ok']);
      assert.deepStrictEqual([h.malwareScanner.name, h.malwareScanner.status], ['clamd (127.0.0.1:1)', 'down']);
      assert.strictEqual(h.status, 'DEGRADED', 'clamd down with real data is degraded');
      assert.ok(!/firstName|lastName|dateOfBirth|phone|emergencyCode/.test(JSON.stringify(h)), 'no personal data');

      const csp = getSecurityHttpHeaders()['Content-Security-Policy'];
      const directive = (name: string) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) || '';
      assert.strictEqual(directive('script-src'), "script-src 'self'", 'no inline script');
      assert.strictEqual(directive('worker-src'), "worker-src 'self'", 'service worker from this origin');
      assert.strictEqual(directive('img-src'), "img-src 'self' data:", 'QR images; no remote images');
      assert.ok(!csp.includes('blob:') && !csp.includes('https:;') && !csp.includes(' * '), 'nothing broader than needed');
      const scan = await fetch(`${base}/s`);
      assert.match(scan.headers.get('permissions-policy') || '', /camera=\(self\)/, 'camera on the scanner page');
      assert.match((await fetch(`${base}/`)).headers.get('permissions-policy') || '', /camera=\(\)/, 'no camera elsewhere');
      assert.strictEqual(scan.headers.get('content-security-policy'), csp);
    } finally {
      s.child.kill();
    }
  });
});
