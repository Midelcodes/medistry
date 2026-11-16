/**
 * Smoke test against a running server: node scripts/smoke.mjs [baseUrl]
 * Covers every page, every patient in the portal picker, clinician sign-in, consent,
 * break-glass, co-sign and the link targets used by the footer, and the offline card:
 * issue a card, verify its token with the browser verifier, upload one offline scan, check the audit chain.
 */
import { verifyCardToken } from '../site/js/lib/verifyCard.js';
import { signScanEvent } from '../site/js/lib/offlineScan.js';
const B = process.argv[2] || 'http://localhost:3000';
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
async function j(path, { method = 'GET', body, token } = {}) {
  const r = await fetch(B + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null; try { d = await r.json(); } catch { /* not json */ }
  return { s: r.status, d };
}

for (const p of ['/', '/about', '/features', '/how-it-works', '/emergency', '/patients', '/clinicians', '/facilities', '/facility-admin', '/status', '/contact', '/s']) {
  ok((await fetch(B + p)).status === 200, `page ${p}`);
}
ok((await fetch(B + '/nope')).status === 404, 'unknown page is 404');

const { d: { patients } } = await j('/api/patients');
for (const p of patients) {
  const r = await j(`/api/patients/${p.id}`);
  ok(r.s === 200 && r.d.patient.id === p.id, `portal loads ${p.firstName} ${p.lastName}`);
  const t = await j(`/api/patients/${p.id}/timeline`);
  ok(t.s === 200 && t.d.timeline.length > 0, `  timeline for ${p.firstName}`);
}
const P = patients[0];

const { d: { clinicians } } = await j('/api/clinicians');
async function login(c) {
  const t = await j(`/api/demo/totp/${c.id}`);
  return (await j('/api/clinician/login', { method: 'POST', body: { clinicianId: c.id, totp: t.d.code } })).d.token;
}
const T1 = await login(clinicians[0]); const T2 = await login(clinicians[1]);
ok(!!T1 && !!T2, 'clinician sign-in');
ok((await j('/api/clinician/me')).s === 401, 'no token is 401');
ok((await j('/api/clinician/me', { token: 'abc.def' })).s === 401, 'forged token is 401');

let r = await j('/api/clinician/access-requests', { method: 'POST', token: T1, body: { patientId: P.id, reason: 'Referral review' } });
const rid = r.d.requestId;
r = await j(`/api/patients/${P.id}/notifications`);
const otp = r.d.notifications.map((n) => n.message.match(/One-time code: (\d{6})/)).find(Boolean)?.[1];
ok(!!otp, 'patient receives the one-time code');
ok((await j(`/api/clinician/access-requests/${rid}/otp`, { method: 'POST', token: T1, body: { otp } })).s === 200, 'OTP grants consent');
ok((await j(`/api/clinician/patients/${P.id}/record`, { token: T1 })).s === 200, 'record readable with consent');
ok((await j(`/api/clinician/patients/${P.id}/record`, { token: T2 })).s === 403, 'other clinician blocked');

r = await j('/api/emergency/break-glass', { method: 'POST', token: T1, body: { code: P.emergencyCode, reason: 'UNCONSCIOUS' } });
ok(r.s === 200, 'break-glass');
const gid = r.d.grantId;
ok((await j(`/api/emergency/grants/${gid}/full-history`, { token: T1 })).s === 403, 'full history locked before co-sign');
ok((await j('/api/clinician/cosign', { method: 'POST', token: T2, body: { grantId: gid, reason: 'Second opinion needed' } })).s === 200, 'co-sign');
ok((await j(`/api/emergency/grants/${gid}/full-history`, { token: T1 })).s === 200, 'full history after co-sign');

ok((await j('/api/audit/verify')).d.valid, 'audit chain verifies');

// ---- Offline emergency card ----
ok((await fetch(B + '/sw.js')).status === 200, 'scanner service worker served');
const { d: jwks } = await j('/.well-known/medistry-keys.json');
ok(Array.isArray(jwks?.keys) && jwks.keys.length > 0 && jwks.keys.every((k) => !('d' in k)), 'public keys published, no private part');
r = await j(`/api/patients/${P.id}/offline-card`, { method: 'POST', body: {} });
ok(r.s === 200 && !!r.d.token && r.d.qrPngDataUrl?.startsWith('data:image/png') && r.d.cardHtml?.includes('<svg'), 'card issued with QR and printable HTML');
const card = r.d;
const verified = await verifyCardToken(card.token, jwks.keys);
ok(verified.status === 'valid' && verified.payload.cv === card.cardVersion, 'card token verifies with the browser verifier');
const [h, pl, sg] = card.token.split('.');
const tampered = `${h}.${pl.slice(0, -2)}${pl.endsWith('A') ? 'BB' : 'AA'}.${sg}`;
ok((await verifyCardToken(tampered, jwks.keys)).status === 'invalid', 'tampered token is rejected');

const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
const devicePublicJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
const c0 = clinicians[0];
const t0 = await j(`/api/demo/totp/${c0.id}`);
r = await j('/api/clinician/login', { method: 'POST', body: { clinicianId: c0.id, totp: t0.d.code, devicePublicJwk } });
ok(r.s === 200 && !!r.d.pass, 'clinician pass issued for a device key');
const before = (await j('/api/stats')).d.auditEntries;
const event = await signScanEvent({
  eventId: crypto.randomUUID(), cardSub: verified.payload.sub, cardVersion: verified.payload.cv, cardKid: JSON.parse(atob(h.replace(/-/g, '+').replace(/_/g, '/'))).kid,
  reason: 'UNCONSCIOUS', scannedAt: new Date().toISOString(), pass: r.d.pass,
}, kp.privateKey);
r = await j('/api/emergency/offline-scans', { method: 'POST', body: { events: [event] } });
ok(r.s === 200 && r.d.results?.[0]?.status === 'accepted' && r.d.results[0].cardStatus === 'current', 'offline scan accepted');
r = await j('/api/emergency/offline-scans', { method: 'POST', body: { events: [event] } });
ok(r.d.results?.[0]?.status === 'duplicate', 'same scan again is a duplicate');
const after = await j('/api/stats');
ok(after.d.auditEntries > before && after.d.auditChainValid, 'audit chain grew and still verifies');
ok((await j(`/api/patients/${P.id}/access-log`)).d.logs.some((l) => l.action === 'OFFLINE_EMERGENCY_SCAN'), 'scan visible in the patient access log');
ok((await j(`/api/patients/${P.id}/notifications`)).d.notifications.some((n) => /emergency card was scanned/.test(n.message)), 'patient notified of the scan');
ok((await j('/api/audit/verify')).d.valid, 'audit chain verifies after the offline scan');

ok((await j('/api/contact', { method: 'POST', body: { name: 'Smoke', email: 'smoke@example.com', message: 'hello' } })).s === 200, 'contact form');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
