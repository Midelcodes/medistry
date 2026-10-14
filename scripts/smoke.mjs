/**
 * Smoke test against a running server: node scripts/smoke.mjs [baseUrl]
 * Covers every page, every patient in the portal picker, clinician sign-in, consent,
 * break-glass, co-sign and the link targets used by the footer.
 */
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

for (const p of ['/', '/about', '/features', '/how-it-works', '/emergency', '/patients', '/clinicians', '/facilities', '/status', '/contact']) {
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
ok((await j('/api/contact', { method: 'POST', body: { name: 'Smoke', email: 'smoke@example.com', message: 'hello' } })).s === 200, 'contact form');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
