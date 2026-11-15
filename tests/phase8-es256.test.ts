import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  createCardKeyStore,
  loadCardKeyStore,
  verifyCompactJws,
  jwkThumbprint,
} from '../src/lib/crypto/cardKeys.ts';
import { generateOfflineSignedPayload, verifyOfflineSignedPayload, OFFLINE_CARD_ISSUER } from '../src/lib/code/deliverables.ts';
import { createPatientRecord } from '../src/lib/patient/profile.ts';

const newKey = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
const now = () => Math.floor(Date.now() / 1000);
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

describe('1. ES256 compact JWS signing and verification', () => {
  const store = createCardKeyStore(newKey());
  const jwks = store.getPublicJwks();
  const claims = () => ({ iss: 'medistry', sub: 'synthetic-1', bloodGroup: 'O_POSITIVE', iat: now(), exp: now() + 3600 });

  test('Sign then verify round-trip succeeds', () => {
    const token = store.signCompactJws(claims());
    const header = decode(token.split('.')[0]);
    assert.deepStrictEqual(header, { alg: 'ES256', typ: 'JWT', kid: store.getKid() });
    const result = verifyCompactJws(token, jwks);
    assert.strictEqual(result.valid, true, result.error);
    assert.strictEqual(result.payload?.bloodGroup, 'O_POSITIVE');
  });

  test('Changing one character of the payload makes verification fail', () => {
    const [h, p, s] = store.signCompactJws(claims()).split('.');
    const i = Math.floor(p.length / 2);
    const flipped = p.slice(0, i) + (p[i] === 'A' ? 'B' : 'A') + p.slice(i + 1);
    const result = verifyCompactJws(`${h}.${flipped}.${s}`, jwks);
    assert.strictEqual(result.valid, false);
    assert.match(result.error || '', /signature mismatch/);
  });

  test('A token whose header says alg HS256 or none is rejected', () => {
    const [, p, s] = store.signCompactJws(claims()).split('.');
    const kid = store.getKid();
    for (const alg of ['HS256', 'none', 'ES384', 'RS256']) {
      const result = verifyCompactJws(`${b64({ alg, typ: 'JWT', kid })}.${p}.${s}`, jwks);
      assert.strictEqual(result.valid, false, alg);
      assert.match(result.error || '', /only ES256/);
    }
    // Classic algorithm confusion: an HMAC "signed" with the public key as the shared secret.
    const h = b64({ alg: 'HS256', typ: 'JWT', kid });
    const mac = crypto.createHmac('sha256', JSON.stringify(jwks[0])).update(`${h}.${p}`).digest('base64url');
    assert.strictEqual(verifyCompactJws(`${h}.${p}.${mac}`, jwks).valid, false);
    // Unsigned token with an empty signature part.
    assert.strictEqual(verifyCompactJws(`${b64({ alg: 'none', typ: 'JWT' })}.${p}.`, jwks).valid, false);
  });

  test('An unknown kid is rejected', () => {
    const other = createCardKeyStore(newKey());
    const result = verifyCompactJws(other.signCompactJws(claims()), jwks);
    assert.strictEqual(result.valid, false);
    assert.match(result.error || '', /Unknown signing key/);
  });

  test('An expired token is rejected; iat more than 5 minutes in the future is rejected', () => {
    const expired = verifyCompactJws(store.signCompactJws({ iat: now() - 7200, exp: now() - 1 }), jwks);
    assert.strictEqual(expired.valid, false);
    assert.match(expired.error || '', /expired/);

    const future = verifyCompactJws(store.signCompactJws({ iat: now() + 301, exp: now() + 7200 }), jwks);
    assert.strictEqual(future.valid, false);
    assert.match(future.error || '', /future/);

    const smallSkew = verifyCompactJws(store.signCompactJws({ iat: now() + 120, exp: now() + 7200 }), jwks);
    assert.strictEqual(smallSkew.valid, true, 'up to 5 minutes of clock skew is allowed');

    const noExp = verifyCompactJws(store.signCompactJws({ iat: now() }), jwks);
    assert.strictEqual(noExp.valid, false, 'exp is required');
  });

  test('The signature is exactly 64 bytes (raw r||s) and verifies with WebCrypto', async () => {
    const token = store.signCompactJws(claims());
    const [h, p, s] = token.split('.');
    const sig = Buffer.from(s, 'base64url');
    assert.strictEqual(sig.length, 64);

    // Same check a browser scanner does: WebCrypto ECDSA expects IEEE P1363 (r||s), not DER.
    const { kty, crv, x, y } = store.getPublicJwk();
    const key = await globalThis.crypto.subtle.importKey('jwk', { kty, crv, x, y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await globalThis.crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, new TextEncoder().encode(`${h}.${p}`));
    assert.strictEqual(ok, true);
  });

  test('kid is the RFC 7638 thumbprint of the public key', () => {
    const jwk = store.getPublicJwk();
    assert.strictEqual(jwk.kid, jwkThumbprint(jwk));
    assert.match(jwk.kid, /^[A-Za-z0-9_-]{43}$/);
    assert.strictEqual(jwk.alg, 'ES256');
    assert.strictEqual(jwk.use, 'sig');
    assert.strictEqual('d' in jwk, false);
  });

  test('A previous key stays valid for verification after rotation', () => {
    const oldKey = newKey();
    const oldToken = createCardKeyStore(oldKey).signCompactJws(claims());
    const rotated = createCardKeyStore(newKey(), [crypto.createPublicKey(oldKey)]);
    assert.strictEqual(rotated.getPublicJwks().length, 2);
    assert.strictEqual(verifyCompactJws(oldToken, rotated.getPublicJwks()).valid, true);
    assert.strictEqual(verifyCompactJws(oldToken, [rotated.getPublicJwk()]).valid, false);
  });
});

describe('2. Key loading and fail-closed behaviour', () => {
  const key = newKey();
  const pem = key.export({ format: 'pem', type: 'pkcs8' }).toString();
  const expectedKid = createCardKeyStore(key).getKid();

  test('Accepts PEM, base64 of the PEM, and base64 PKCS8 DER', () => {
    for (const value of [pem, Buffer.from(pem).toString('base64'), key.export({ format: 'der', type: 'pkcs8' }).toString('base64')]) {
      assert.strictEqual(loadCardKeyStore({ OFFLINE_CARD_PRIVATE_KEY: value }).getKid(), expectedKid);
    }
  });

  test('Production with DEMO_MODE=0 throws when the key is missing, invalid or not P-256', () => {
    const prod = { NODE_ENV: 'production', DEMO_MODE: '0' };
    assert.throws(() => loadCardKeyStore(prod), /OFFLINE_CARD_PRIVATE_KEY is not set/);
    assert.throws(() => loadCardKeyStore({ ...prod, OFFLINE_CARD_PRIVATE_KEY: 'not-a-key' }), /invalid/);
    const p384 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    assert.throws(() => loadCardKeyStore({ ...prod, OFFLINE_CARD_PRIVATE_KEY: p384 }), /invalid/);
    assert.strictEqual(loadCardKeyStore({ ...prod, OFFLINE_CARD_PRIVATE_KEY: pem }).getKid(), expectedKid);
  });

  test('Dev or demo without a key uses an ephemeral P-256 key and warns', (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const store = loadCardKeyStore({ NODE_ENV: 'production', DEMO_MODE: '1' });
    assert.strictEqual(store.getPublicJwk().crv, 'P-256');
    assert.strictEqual(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /random per-process P-256 key/);
  });
});

describe('3. Offline card payload uses ES256 and an honest issuer', () => {
  const patient = createPatientRecord(
    { firstName: 'Test', lastName: 'Synthetic', dateOfBirth: '1990-01-01', gender: 'female' },
    {
      bloodGroup: 'B_POSITIVE',
      genotype: 'AS',
      allergies: [{ substance: 'Sulfa Drugs', category: 'drug', reaction: 'Rash', severity: 'severe' }],
      emergencyContacts: [{ id: 'c1', name: 'Synthetic Contact', relationship: 'Sibling', phone: '+234 800 000 0000', priority: 1 }],
      advanceDirectiveDnr: false,
      organDonor: false,
    },
    { userId: 'u-synthetic', countryCode: 'NG' }
  );

  test('generateOfflineSignedPayload issues ES256 tokens from issuer "medistry" that verify', () => {
    const { token, payload, signature } = generateOfflineSignedPayload(patient, 'K7QM-4T9X-2HDP-8W2', 30);
    assert.strictEqual(OFFLINE_CARD_ISSUER, 'medistry');
    assert.strictEqual(payload.iss, 'medistry');
    assert.strictEqual(decode(token.split('.')[0]).alg, 'ES256');
    assert.strictEqual(signature, token.split('.')[2]);
    const result = verifyOfflineSignedPayload(token);
    assert.strictEqual(result.valid, true, result.error);
    assert.strictEqual(result.payload?.iss, 'medistry');
  });
});

describe('4. JWKS endpoint', () => {
  const PORT = 34000 + Math.floor(Math.random() * 2000);
  let server: ChildProcess;

  before(async () => {
    const env = { ...process.env, STORAGE: 'memory', PORT: String(PORT) };
    delete env.OFFLINE_CARD_PRIVATE_KEY;
    server = spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], { env, stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) return; } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('server did not start');
  });
  after(() => { server?.kill(); });

  test('Returns EC P-256 public keys with no private part, cacheable for an hour', async () => {
    const res = await fetch(`http://localhost:${PORT}/.well-known/medistry-keys.json`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('cache-control'), 'public, max-age=3600');
    const body = await res.json();
    assert.ok(Array.isArray(body.keys) && body.keys.length >= 1);
    for (const k of body.keys) {
      assert.strictEqual(k.kty, 'EC');
      assert.strictEqual(k.crv, 'P-256');
      assert.strictEqual(k.alg, 'ES256');
      assert.strictEqual(k.use, 'sig');
      assert.ok(k.x && k.y && k.kid);
      assert.strictEqual('d' in k, false, 'private key component must never be published');
    }
  });
});
