import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
// The same ES module the browser scanner loads from /js/lib/verifyCard.js
import { verifyCardToken, extractToken, MAX_IAT_SKEW_SECONDS } from '../site/js/lib/verifyCard.js';
import { createCardKeyStore, getPublicJwks } from '../src/lib/crypto/cardKeys.ts';
import { OfflineCardStore } from '../src/lib/emergency/offlineCardStore.ts';
import { buildCardQrText } from '../src/lib/code/deliverables.ts';
import { createPatientRecord } from '../src/lib/patient/profile.ts';
import { SCANNER_KEYS, TRANSLATIONS } from '../src/lib/i18n/translations.ts';

const now = () => Math.floor(Date.now() / 1000);
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function realCard() {
  const patient = createPatientRecord(
    { firstName: 'Test', lastName: 'Synthetic', dateOfBirth: '1990-01-01', gender: 'female' },
    {
      bloodGroup: 'AB_NEGATIVE', genotype: 'AS',
      allergies: [{ substance: 'Penicillin', category: 'drug', reaction: 'Anaphylaxis', severity: 'severe' }],
      emergencyContacts: [{ id: 'c1', name: 'Synthetic Contact', relationship: 'Sibling', phone: '+234 800 000 0001', priority: 1 }],
      advanceDirectiveDnr: true,
    },
    { userId: 'u-synthetic', countryCode: 'NG' }
  );
  return new OfflineCardStore().issue(patient);
}

describe('1. Browser verifier (site/js/lib/verifyCard.js) against server-signed tokens', () => {
  test('Valid: a real issued card verifies and returns the payload', async () => {
    const { token } = realCard();
    const r = await verifyCardToken(token, getPublicJwks());
    assert.strictEqual(r.status, 'valid', r.error);
    assert.strictEqual(r.payload.e.bg, 'AB-');
    assert.strictEqual(r.payload.e.dnr, true);
    assert.strictEqual(r.payload.cv, 1);
  });

  test('Tampered: one changed payload character is NOT GENUINE and returns no data', async () => {
    const [h, p, s] = realCard().token.split('.');
    const i = Math.floor(p.length / 2);
    const tampered = `${h}.${p.slice(0, i)}${p[i] === 'A' ? 'B' : 'A'}${p.slice(i + 1)}.${s}`;
    const r = await verifyCardToken(tampered, getPublicJwks());
    assert.strictEqual(r.status, 'invalid');
    assert.strictEqual(r.payload, undefined);

    // Re-encoded payload with a changed blood group, original signature
    const body = JSON.parse(Buffer.from(p, 'base64url').toString());
    body.e.bg = 'O-';
    const forged = await verifyCardToken(`${h}.${b64(body)}.${s}`, getPublicJwks());
    assert.strictEqual(forged.status, 'invalid');
    assert.strictEqual(forged.payload, undefined);
  });

  test('Wrong alg: HS256, none and RS256 headers are rejected', async () => {
    const [h, p, s] = realCard().token.split('.');
    const kid = JSON.parse(Buffer.from(h, 'base64url').toString()).kid;
    for (const alg of ['HS256', 'none', 'RS256', 'ES384']) {
      const r = await verifyCardToken(`${b64({ alg, typ: 'JWT', kid })}.${p}.${s}`, getPublicJwks());
      assert.strictEqual(r.status, 'invalid', alg);
      assert.strictEqual(r.payload, undefined);
    }
    // HMAC "signed" with the public key as secret (algorithm confusion)
    const hh = b64({ alg: 'HS256', typ: 'JWT', kid });
    const mac = crypto.createHmac('sha256', JSON.stringify(getPublicJwks()[0])).update(`${hh}.${p}`).digest('base64url');
    assert.strictEqual((await verifyCardToken(`${hh}.${p}.${mac}`, getPublicJwks())).status, 'invalid');
  });

  test('Unknown kid: cannot verify, no data', async () => {
    const other = createCardKeyStore(crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey);
    const token = other.signCompactJws({ iss: 'medistry', v: 1, cv: 1, iat: now(), exp: now() + 3600, e: { bg: 'O+', gt: 'AA' } });
    const r = await verifyCardToken(token, getPublicJwks());
    assert.strictEqual(r.status, 'unknown_key');
    assert.strictEqual(r.payload, undefined);
    assert.strictEqual((await verifyCardToken(token, [])).status, 'unknown_key');
  });

  test('Expired: genuine signature, payload returned for UNVERIFIED-CURRENT display', async () => {
    const issued = new OfflineCardStore().issue(realCardPatient(), { validityDays: 1 });
    const later = issued.payload.exp + 60;
    const r = await verifyCardToken(issued.token, getPublicJwks(), { nowSeconds: later });
    assert.strictEqual(r.status, 'expired');
    assert.strictEqual(r.payload.e.bg, 'O+');
    // Exactly at exp counts as expired, one second before is valid
    assert.strictEqual((await verifyCardToken(issued.token, getPublicJwks(), { nowSeconds: issued.payload.exp })).status, 'expired');
    assert.strictEqual((await verifyCardToken(issued.token, getPublicJwks(), { nowSeconds: issued.payload.exp - 1 })).status, 'valid');
  });

  test('iat more than 5 minutes in the future is rejected without data; small skew is fine', async () => {
    const store = createCardKeyStore(crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey);
    const jwks = store.getPublicJwks();
    const claims = (iat: number) => ({ iss: 'medistry', v: 1, cv: 1, iat, exp: iat + 86400, e: { bg: 'O+', gt: 'AA' } });
    const future = await verifyCardToken(store.signCompactJws(claims(now() + MAX_IAT_SKEW_SECONDS + 5)), jwks);
    assert.strictEqual(future.status, 'future');
    assert.strictEqual(future.payload, undefined);
    assert.strictEqual((await verifyCardToken(store.signCompactJws(claims(now() + 120)), jwks)).status, 'valid');
  });

  test('Genuine signature but wrong issuer, legacy format or no expiry is not shown', async () => {
    const store = createCardKeyStore(crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey);
    const jwks = store.getPublicJwks();
    const base = { iss: 'medistry', v: 1, cv: 1, iat: now(), exp: now() + 3600, e: { bg: 'O+', gt: 'AA' } };
    assert.strictEqual((await verifyCardToken(store.signCompactJws({ ...base, iss: 'not-medistry' }), jwks)).status, 'invalid');
    assert.strictEqual((await verifyCardToken(store.signCompactJws({ ...base, v: undefined }), jwks)).status, 'unsupported');
    assert.strictEqual((await verifyCardToken(store.signCompactJws({ ...base, exp: undefined }), jwks)).status, 'invalid');
  });

  test('Malformed input is rejected', async () => {
    for (const bad of ['', 'abc', 'a.b', 'a.b.c.d', '<script>.x.y', null]) {
      assert.strictEqual((await verifyCardToken(bad as string, getPublicJwks())).status, 'invalid', String(bad));
    }
  });

  test('extractToken accepts the QR link, a bare token or pasted text, and rejects anything else', () => {
    const { token } = realCard();
    assert.strictEqual(extractToken(buildCardQrText(token, 'https://demo.example')), token);
    assert.strictEqual(extractToken(`  ${token}\n`), token);
    assert.strictEqual(extractToken(`https://demo.example/s#${encodeURIComponent(token)}`), token);
    assert.strictEqual(extractToken('https://example.com/e/K7QM-4T9X-2HDP-8W2'), '');
    assert.strictEqual(extractToken('hello'), '');
  });
});

function realCardPatient() {
  return createPatientRecord(
    { firstName: 'Test', lastName: 'Synthetic', dateOfBirth: '1990-01-01', gender: 'male' },
    { bloodGroup: 'O_POSITIVE', genotype: 'AA' },
    { userId: 'u-synthetic-2', countryCode: 'NG' }
  );
}

describe('2. Scanner page, service worker and strings', () => {
  const PORT = 38000 + Math.floor(Math.random() * 1000);
  const base = `http://localhost:${PORT}`;
  let server: ChildProcess;

  before(async () => {
    server = spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], { env: { ...process.env, STORAGE: 'memory', PORT: String(PORT) }, stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('server did not start');
  });
  after(() => { server?.kill(); });

  test('/s serves the scanner with the embedded JWKS and strings, camera allowed only here', async () => {
    const res = await fetch(`${base}/s`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('permissions-policy') || '', /camera=\(self\)/);
    const html = await res.text();
    assert.match(html, /<title>Emergency Scan \| Medistry<\/title>/);
    assert.match(html, /<script type="module" src="\/js\/scan\.js"><\/script>/);

    const jwks = JSON.parse(html.match(/<script type="application\/json" id="medistry-jwks">([^<]*)<\/script>/)![1]);
    const published = await (await fetch(`${base}/.well-known/medistry-keys.json`)).json();
    assert.deepStrictEqual(jwks.keys, published.keys);
    assert.ok(jwks.keys.every((k: Record<string, unknown>) => !('d' in k)));

    const strings = JSON.parse(html.match(/<script type="application\/json" id="medistry-scan-i18n">([^<]*)<\/script>/)![1]);
    assert.strictEqual(strings.en.scan_not_genuine, 'CARD NOT GENUINE: do not rely on this data');
    assert.strictEqual(strings.sw.scan_valid_badge, 'KADI HALALI');

    // Other pages keep the camera blocked
    assert.match((await fetch(`${base}/`)).headers.get('permissions-policy') || '', /camera=\(\)/);
  });

  test('Every precached file is served, and the service worker is served from the root', async () => {
    const sw = await fetch(`${base}/sw.js`);
    assert.strictEqual(sw.status, 200);
    assert.match(sw.headers.get('content-type') || '', /javascript/);
    const src = await sw.text();
    assert.match(src, /const CACHE_VERSION = 'medistry-scan-v\d+';/);
    const list = src.match(/const PRECACHE = \[([\s\S]*?)\];/)![1];
    const urls = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]).concat(list.includes('JWKS_URL') ? ['/.well-known/medistry-keys.json'] : []);
    for (const u of ['/s', '/js/scan.js', '/js/lib/verifyCard.js', '/js/lib/offlineScan.js', '/js/lib/scanStore.js', '/css/scan.css', '/vendor/jsQR.js', '/assets/favicon.svg', '/.well-known/medistry-keys.json']) {
      assert.ok(urls.includes(u), `precache list includes ${u}`);
    }
    for (const u of urls) assert.strictEqual((await fetch(`${base}${u}`)).status, 200, u);
    assert.strictEqual((await fetch(`${base}/vendor/jsQR-LICENSE.txt`)).status, 200);
  });

  test('Static file routing blocks path traversal and unknown types', async () => {
    for (const p of ['/js/../server.ts', '/js/%2e%2e/layout.html', '/js/lib/../../layout.html', '/vendor/.hidden.js', '/js/a/b/c.js']) {
      const r = await fetch(`${base}${p}`);
      assert.notStrictEqual(r.status, 200, p);
    }
  });

  test('The scanner never sends the card token or card contents: it fetches keys and uploads signed scan events only', () => {
    const src = fs.readFileSync('site/js/scan.js', 'utf-8');
    const fetches = [...src.matchAll(/fetch\(([^,)]+)/g)].map((m) => m[1].trim());
    assert.deepStrictEqual(fetches, ['JWKS_URL', 'SCANS_URL']);
    assert.match(src, /body: JSON\.stringify\(\{ events: batch \}\)/);
    // The event carries the card's subject, version and key id, never the token or medical fields
    const record = src.slice(src.indexOf('async function recordScan'), src.indexOf('async function lastCardStatus'));
    assert.deepStrictEqual([...record.matchAll(/^\s{4}(\w+)[,:]/gm)].map((m) => m[1]), ['eventId', 'cardSub', 'cardVersion', 'cardKid', 'reason', 'details', 'scannedAt', 'pass']);
    assert.ok(!/payload\.e\b|token\b(?!:)/.test(record.replace('ctx.pass.token', '')), 'no card contents or card token in the event');
    for (const banned of ['XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource', 'innerHTML', 'insertAdjacentHTML']) {
      assert.ok(!src.includes(banned), `scan.js must not use ${banned}`);
    }
    assert.match(src, /history\.replaceState\(null, '', location\.pathname \+ location\.search\)/);
  });

  test('Every scanner string has a Swahili translation', () => {
    assert.ok(SCANNER_KEYS.length >= 30);
    for (const k of SCANNER_KEYS) assert.ok(TRANSLATIONS.sw[k], `sw missing ${k}`);
  });
});
