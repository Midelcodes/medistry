// Phase 9 security checks for the offline card feature: key exposure, rate limits, cookie/CSRF model,
// fail-closed start-up and patient data in logs.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { signScanEvent } from '../site/js/lib/offlineScan.js';

const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KEY_B64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const PRIVATE_D = (privateKey.export({ format: 'jwk' }) as JsonWebKey).d!;
const strongHex = () => crypto.randomBytes(32).toString('hex');

function startServer(env: Record<string, string | undefined>, port: number) {
  const output: string[] = [];
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], {
    env: { ...process.env, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => output.push(String(d)));
  child.stderr!.on('data', (d) => output.push(String(d)));
  return { child, output };
}
async function waitUp(base: string) {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}

describe('Running server with a configured card key', () => {
  const PORT = 42000 + Math.floor(Math.random() * 1000);
  const base = `http://localhost:${PORT}`;
  let server: { child: ChildProcess; output: string[] };
  let patient: { id: string };
  let token: string;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  before(async () => {
    server = startServer({ OFFLINE_CARD_PRIVATE_KEY: KEY_B64 }, PORT);
    await waitUp(base);
    patient = (await (await fetch(`${base}/api/patients`)).json()).patients[0];
    token = (await (await fetch(`${base}/api/patients/${patient.id}/offline-card`)).json()).token;
  });
  after(() => { server.child.kill(); });

  test('No private key material is reachable through the API or any static path', async () => {
    const paths = [
      '/', '/s', '/sw.js', '/.well-known/medistry-keys.json', '/api/health', '/api/stats', '/api/audit/verify',
      '/api/patients', '/api/clinicians', '/api/facilities', `/api/patients/${patient.id}`, `/api/patients/${patient.id}/offline-cards`,
      `/api/patients/${patient.id}/offline-card`, '/emergency/offline-card', '/.env', '/.env.example', '/package.json',
      '/scripts/gen-card-key.mjs', '/src/lib/crypto/cardKeys.ts', '/prisma/schema.prisma', '/js/../.env', '/js/%2e%2e/%2e%2e/.env',
      '/vendor/../../.env', '/js/lib/../../../.env', '/assets/..%2f..%2f.env', '/api/nope', '/nope',
    ];
    for (const p of paths) {
      const body = await (await fetch(`${base}${p}`)).text();
      for (const secret of [KEY_B64, PRIVATE_D, 'BEGIN PRIVATE KEY', 'OFFLINE_CARD_PRIVATE_KEY=']) {
        assert.ok(!body.includes(secret), `${p} must not expose ${secret.slice(0, 20)}`);
      }
    }
    const { keys } = await (await fetch(`${base}/.well-known/medistry-keys.json`)).json();
    assert.ok(keys.length >= 1 && keys.every((k: Record<string, unknown>) => !('d' in k)));
    for (const p of ['/.env', '/scripts/gen-card-key.mjs', '/src/lib/crypto/cardKeys.ts', '/js/../.env']) {
      assert.notStrictEqual((await fetch(`${base}${p}`)).status, 200, p);
    }
  });

  test('New endpoints have their own rate limits', async () => {
    // Offline-scan uploads: 20 per minute per IP
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) statuses.push((await post('/api/emergency/offline-scans', { events: [] })).status);
    assert.deepStrictEqual(statuses.slice(0, 20), new Array(20).fill(400));
    assert.strictEqual(statuses[21], 429);

    // Card endpoints: 30 per minute per IP (this test already used one card call in before())
    const card: number[] = [];
    for (let i = 0; i < 31; i++) card.push((await fetch(`${base}/api/patients/${patient.id}/offline-cards`)).status);
    assert.ok(card.includes(429), 'card endpoints are limited');

    // Device-key binding: 10 per minute per IP
    const clin = (await (await fetch(`${base}/api/clinicians`)).json()).clinicians[0];
    const totp = (await (await fetch(`${base}/api/demo/totp/${clin.id}`)).json()).code;
    const { token: session } = await (await post('/api/clinician/login', { clinicianId: clin.id, totp })).json();
    const dk: number[] = [];
    for (let i = 0; i < 11; i++) dk.push((await post('/api/clinician/device-key', { publicJwk: { kty: 'EC' } }, { Authorization: `Bearer ${session}` })).status);
    assert.deepStrictEqual([dk[0], dk[10]], [400, 429]);
  });

  test('CSRF model: new state-changing clinician endpoints ignore the session cookie; the cookie is HttpOnly and SameSite=Strict', async () => {
    const port2 = PORT + 1;
    const fresh = startServer({ OFFLINE_CARD_PRIVATE_KEY: KEY_B64 }, port2);
    try {
      const b2 = `http://localhost:${port2}`;
      await waitUp(b2);
      const clin = (await (await fetch(`${b2}/api/clinicians`)).json()).clinicians[0];
      const totp = (await (await fetch(`${b2}/api/demo/totp/${clin.id}`)).json()).code;
      const login = await fetch(`${b2}/api/clinician/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clinicianId: clin.id, totp }) });
      const cookie = login.headers.get('set-cookie') || '';
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Strict/);
      const cookieOnly = { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' };
      const kp = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair;
      const jwk = await globalThis.crypto.subtle.exportKey('jwk', kp.publicKey);
      assert.strictEqual((await fetch(`${b2}/api/clinician/device-key`, { method: 'POST', headers: cookieOnly, body: JSON.stringify({ publicJwk: jwk }) })).status, 401);
      assert.strictEqual((await fetch(`${b2}/api/clinician/record-flags`, { headers: cookieOnly })).status, 401);
    } finally {
      fresh.child.kill();
    }
  });

  test('No patient data, tokens or passes in the server logs after a full card flow', async () => {
    const { patient: full } = await (await fetch(`${base}/api/patients/${patient.id}`)).json();
    // A fresh server (fresh rate-limit budget): issue a card, sign in with a device key, upload a scan, flag a record.
    const port3 = PORT + 2;
    const s3 = startServer({ OFFLINE_CARD_PRIVATE_KEY: KEY_B64 }, port3);
    try {
      const b3 = `http://localhost:${port3}`;
      await waitUp(b3);
      const p = (await (await fetch(`${b3}/api/patients`)).json()).patients[0];
      const card = await (await fetch(`${b3}/api/patients/${p.id}/offline-card`)).json();
      const clin = (await (await fetch(`${b3}/api/clinicians`)).json()).clinicians[0];
      const totp = (await (await fetch(`${b3}/api/demo/totp/${clin.id}`)).json()).code;
      const kp = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair;
      const login = await (await fetch(`${b3}/api/clinician/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clinicianId: clin.id, totp, devicePublicJwk: await globalThis.crypto.subtle.exportKey('jwk', kp.publicKey) }) })).json();
      const ev = await signScanEvent({ eventId: crypto.randomUUID(), cardSub: p.id, cardVersion: card.cardVersion, cardKid: 'kid', reason: 'OTHER', details: 'Synthetic free-text reason detail', scannedAt: new Date().toISOString(), pass: login.pass }, kp.privateKey);
      const up = await (await fetch(`${b3}/api/emergency/offline-scans`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events: [ev] }) })).json();
      assert.strictEqual(up.results[0].status, 'accepted');
      await fetch(`${b3}/api/patients/${p.id}/records/nope/flag`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: 'Synthetic flag note text' }) });
      await new Promise((r) => setTimeout(r, 300));
      const logs = s3.output.join('');
      for (const banned of [card.token, login.pass, full.firstName, full.lastName, ...full.emergencyContacts.map((c: { phone: string }) => c.phone),
        ...full.allergies.map((a: { substance: string }) => a.substance), 'Synthetic free-text reason detail', 'Synthetic flag note text', KEY_B64]) {
        assert.ok(!logs.includes(banned), `logs must not contain ${String(banned).slice(0, 24)}`);
      }
    } finally {
      s3.child.kill();
    }
  });
});

describe('Fail closed in production', () => {
  test('NODE_ENV=production with DEMO_MODE=0 refuses to start without OFFLINE_CARD_PRIVATE_KEY, and starts with it', async () => {
    const port = 43500 + Math.floor(Math.random() * 400);
    const env = { NODE_ENV: 'production', DEMO_MODE: '0', JWT_SECRET: strongHex(), FIELD_ENCRYPTION_KEY: strongHex(), OFFLINE_CARD_PRIVATE_KEY: '' };
    const missing = startServer(env, port);
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => { missing.child.kill(); resolve(-1); }, 15000);
      missing.child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
    });
    assert.notStrictEqual(code, 0);
    assert.notStrictEqual(code, -1, 'must exit, not keep running');
    assert.match(missing.output.join(''), /OFFLINE_CARD_PRIVATE_KEY is not set/);

    const withKey = startServer({ ...env, OFFLINE_CARD_PRIVATE_KEY: KEY_B64 }, port + 1);
    try {
      await waitUp(`http://localhost:${port + 1}`);
      // Demo-only routes stay closed outside demo mode
      assert.strictEqual((await fetch(`http://localhost:${port + 1}/api/patients`)).status, 404);
      assert.strictEqual((await fetch(`http://localhost:${port + 1}/emergency/offline-card`)).status, 404);
    } finally {
      withKey.child.kill();
    }
  });
});
