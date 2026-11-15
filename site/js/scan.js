/* Offline emergency card scanner (/s).
 * Verifies the card's ES256 signature on this device with WebCrypto. The token and the decoded data are
 * never sent anywhere: the only network request this page makes is for the public keys.
 * Input order: token in the URL hash (QR opened with a phone camera) > camera scan > pasted link or code.
 */
import { verifyCardToken, extractToken } from '/js/lib/verifyCard.js';

const JWKS_URL = '/.well-known/medistry-keys.json';
const KEY_STORE = 'medistry.scan.jwks';
const $ = (sel) => document.querySelector(sel);

// ---------- Strings (from the server's i18n module, embedded in the page) ----------
const ALL_STRINGS = readJson('#medistry-scan-i18n') || {};
const LOCALE = (() => {
  const wanted = (navigator.languages || [navigator.language || 'en']).map((l) => String(l).slice(0, 2).toLowerCase());
  return wanted.find((l) => ALL_STRINGS[l]) || 'en';
})();
function tr(key, params) {
  let text = (ALL_STRINGS[LOCALE] && ALL_STRINGS[LOCALE][key]) || (ALL_STRINGS.en && ALL_STRINGS.en[key]) || key;
  for (const [k, v] of Object.entries(params || {})) text = text.split(`{${k}}`).join(String(v));
  return text;
}
function applyStrings() {
  document.documentElement.lang = LOCALE;
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = tr(el.dataset.i18n); });
}

function readJson(sel) {
  try { return JSON.parse($(sel)?.textContent || 'null'); } catch { return null; }
}

// ---------- Keys: embedded in the page, refreshed from the network, kept in localStorage ----------
function validKeys(keys) {
  return Array.isArray(keys) && keys.length > 0 &&
    keys.every((k) => k && k.kty === 'EC' && k.crv === 'P-256' && typeof k.kid === 'string' && typeof k.x === 'string' && typeof k.y === 'string' && !('d' in k));
}
function storedKeys() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY_STORE) || 'null');
    return v && validKeys(v.keys) ? v : null;
  } catch { return null; }
}
function storeKeys(entry) {
  try { localStorage.setItem(KEY_STORE, JSON.stringify(entry)); } catch { /* private mode or storage blocked */ }
}
/** The newest key set we have: embedded (page render time) or stored (server Date of the last fetch). */
function currentKeys() {
  const embedded = readJson('#medistry-jwks');
  const emb = embedded && validKeys(embedded.keys) ? { keys: embedded.keys, at: Number(embedded.generatedAt) || 0 } : null;
  const sto = storedKeys();
  const stoEntry = sto ? { keys: sto.keys, at: Number(sto.fetchedAt) || 0 } : null;
  if (emb && stoEntry) return (stoEntry.at > emb.at ? stoEntry : emb).keys;
  return (stoEntry || emb || { keys: [] }).keys;
}
async function refreshKeys() {
  try {
    const res = await fetch(JWKS_URL, { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) return false;
    const body = await res.json();
    if (!validKeys(body.keys)) return false;
    // Use the server's Date header, so a copy served from the offline cache does not look newer than it is.
    const fetchedAt = Date.parse(res.headers.get('date') || '') || Date.now();
    storeKeys({ keys: body.keys, fetchedAt });
    return true;
  } catch { return false; }
}

// ---------- Online / offline indicator ----------
function showNetwork() {
  const el = $('#net-status');
  const online = navigator.onLine;
  el.textContent = tr(online ? 'scan_online' : 'scan_offline');
  el.className = `net-pill ${online ? 'online' : 'offline'}`;
}

// ---------- Rendering (textContent only; card data is never parsed as HTML) ----------
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function fmtDay(seconds) {
  if (typeof seconds !== 'number') return tr('scan_unknown');
  try {
    return new Date(seconds * 1000).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return new Date(seconds * 1000).toISOString().slice(0, 10);
  }
}
function setMsg(text) { $('#scan-msg').textContent = text || ''; }

function showInput() {
  $('#scan-result').hidden = true;
  $('#scan-result').replaceChildren();
  $('#scan-input').hidden = false;
  $('#paste-input').value = '';
  setMsg('');
}

function againButton() {
  const b = el('button', 'scan-btn res-again', tr('scan_again'));
  b.type = 'button';
  b.addEventListener('click', showInput);
  return b;
}

function renderStop(kind, title, detail) {
  const box = el('div', `res-stop ${kind}`);
  box.setAttribute('role', 'alert');
  box.append(el('h2', null, title));
  if (detail) box.append(el('p', null, detail));
  const again = againButton();
  box.append(again);
  showResult(box);
  again.focus();
}

function renderCard(payload, expired) {
  const e = payload.e || {};
  const wrap = el('div', expired ? 'res-unverified' : null);

  if (expired) {
    const warn = el('div', 'res-expired', tr('scan_expired', { date: fmtDay(payload.exp) }));
    warn.setAttribute('role', 'alert');
    warn.append(el('p', null, tr('scan_unverified_current')));
    wrap.append(warn);
  } else {
    wrap.append(el('span', 'res-badge', tr('scan_valid_badge')));
  }

  const vitals = el('div', 'res-vitals');
  for (const [label, value] of [['scan_blood_group', e.bg], ['scan_genotype', e.gt]]) {
    const box = el('div', 'res-vital');
    box.append(el('div', 'res-label', tr(label)), el('div', 'res-big', value && value !== 'unknown' ? value : tr('scan_unknown')));
    vitals.append(box);
  }
  wrap.append(vitals);

  if (e.dnr) {
    const dnr = el('div', 'res-dnr', tr('scan_dnr'));
    dnr.setAttribute('role', 'alert');
    wrap.append(dnr);
  }

  const alg = el('div', 'res-allergies');
  alg.append(el('div', 'res-label', tr('scan_severe_allergies')));
  if (Array.isArray(e.alg) && e.alg.length) {
    const ul = el('ul');
    for (const a of e.alg) ul.append(el('li', null, a.r ? `${a.s}: ${a.r}` : a.s));
    alg.append(ul);
  } else {
    alg.append(el('p', null, tr('scan_no_allergies')));
  }
  wrap.append(alg);

  const list = (labelKey, items) => {
    const sec = el('div', 'res-section');
    sec.append(el('div', 'res-label', tr(labelKey)));
    const ul = el('ul');
    for (const i of items) ul.append(el('li', null, i));
    sec.append(ul);
    wrap.append(sec);
  };
  if (Array.isArray(e.cond) && e.cond.length) list('scan_conditions', e.cond);
  if (Array.isArray(e.med) && e.med.length) list('scan_medications', e.med.map((m) => (m.d ? `${m.n}: ${m.d}` : m.n)));
  if (e.dx && e.dx.t) {
    const sec = el('div', 'res-section');
    sec.append(el('div', 'res-label', tr('scan_recent_dx')), el('p', null, e.dx.d ? `${e.dx.t} (${e.dx.d})` : e.dx.t));
    wrap.append(sec);
  }
  if (e.od) wrap.append(el('div', 'res-section', tr('scan_organ_donor')));

  if (e.ec && (e.ec.n || e.ec.p)) {
    const sec = el('div', 'res-section');
    sec.append(el('div', 'res-label', tr('scan_contact')), el('p', null, [e.ec.n, e.ec.p].filter(Boolean).join(' · ')));
    const digits = String(e.ec.p || '').replace(/[^\d+]/g, '');
    if (digits) {
      const call = el('a', 'res-call', tr('scan_call', { name: e.ec.n || e.ec.p }));
      call.href = `tel:${digits}`;
      call.setAttribute('aria-label', `${tr('scan_call', { name: e.ec.n || '' })} ${e.ec.p}`);
      sec.append(call);
    }
    wrap.append(sec);
  }

  const foot = el('p', 'res-foot', tr(expired ? 'scan_footer_unverified' : 'scan_footer_verified', { cv: payload.cv ?? '?', date: fmtDay(payload.iat) }));
  if (!expired) foot.append(document.createElement('br'), document.createTextNode(tr('scan_valid_until', { date: fmtDay(payload.exp) })));
  wrap.append(foot, againButton());
  showResult(wrap);
}

function showResult(node) {
  $('#scan-input').hidden = true;
  const out = $('#scan-result');
  out.replaceChildren(node);
  out.hidden = false;
  window.scrollTo(0, 0);
}

// ---------- Verification ----------
async function handleToken(raw) {
  const token = extractToken(raw);
  if (!token) { setMsg(tr('scan_no_token')); return; }
  setMsg(tr('scan_checking'));
  let result = await verifyCardToken(token, currentKeys());
  if (result.status === 'unknown_key' && navigator.onLine && await refreshKeys()) {
    result = await verifyCardToken(token, currentKeys());
  }
  setMsg('');
  switch (result.status) {
    case 'valid': return renderCard(result.payload, false);
    case 'expired': return renderCard(result.payload, true);
    case 'unknown_key': return renderStop('amber', tr('scan_unknown_key'));
    case 'future': return renderStop('amber', tr('scan_future'));
    case 'unsupported': return renderStop('amber', tr('scan_unsupported'));
    default: return renderStop('red', tr('scan_not_genuine'), tr('scan_not_genuine_detail'));
  }
}

// ---------- Camera: BarcodeDetector, else vendored jsQR ----------
let stream = null;
let scanning = false;

function loadJsQr() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/jsQR.js';
    s.onload = () => (window.jsQR ? resolve(window.jsQR) : reject(new Error('jsQR missing')));
    s.onerror = () => reject(new Error('jsQR failed to load'));
    document.head.append(s);
  });
}

async function makeDecoder(video) {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        return async () => (await detector.detect(video))[0]?.rawValue || '';
      }
    } catch { /* fall back to jsQR */ }
  }
  const jsQR = await loadJsQr();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return async () => {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return '';
    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    return jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' })?.data || '';
  };
}

async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { setMsg(tr('scan_camera_unavailable')); return; }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  } catch (err) {
    setMsg(tr(err && err.name === 'NotAllowedError' ? 'scan_camera_denied' : 'scan_camera_unavailable'));
    return;
  }
  const video = $('#cam-video');
  video.srcObject = stream;
  $('#camera-box').hidden = false;
  $('#cam-start').hidden = true;
  $('#cam-stop').hidden = false;
  setMsg('');
  await video.play().catch(() => {});
  let decode;
  try { decode = await makeDecoder(video); } catch { stopCamera(); setMsg(tr('scan_camera_unavailable')); return; }
  scanning = true;
  let lastBad = '';
  const tick = async () => {
    if (!scanning) return;
    let text = '';
    try { text = await decode(); } catch { /* frame not ready */ }
    if (text) {
      if (extractToken(text)) { stopCamera(); await handleToken(text); return; }
      if (text !== lastBad) { lastBad = text; setMsg(tr('scan_no_token')); }
    }
    setTimeout(() => requestAnimationFrame(tick), 120);
  };
  requestAnimationFrame(tick);
}

function stopCamera() {
  scanning = false;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  $('#cam-video').srcObject = null;
  $('#camera-box').hidden = true;
  $('#cam-start').hidden = false;
  $('#cam-stop').hidden = true;
}

// ---------- Start ----------
function init() {
  applyStrings();
  showNetwork();
  window.addEventListener('online', () => { showNetwork(); refreshKeys(); });
  window.addEventListener('offline', showNetwork);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/s' }).catch(() => { /* offline support unavailable */ });
  }
  if (navigator.onLine) refreshKeys();

  $('#cam-start').addEventListener('click', startCamera);
  $('#cam-stop').addEventListener('click', stopCamera);
  $('#paste-form').addEventListener('submit', (ev) => { ev.preventDefault(); handleToken($('#paste-input').value); });

  // a. Token in the URL hash, on load and when a card link opens in this same tab.
  readHash();
  window.addEventListener('hashchange', readHash);
}

/** Reads a token from the URL hash, then removes it from the address bar and history. */
function readHash() {
  if (location.hash.length <= 1) return;
  const fromHash = location.hash.slice(1);
  history.replaceState(null, '', location.pathname + location.search);
  stopCamera();
  handleToken(fromHash);
}

init();
