/**
 * Offline emergency card verification (ES module, WebCrypto only).
 * Runs in the browser scanner (/s) and in Node 22+ tests (globalThis.crypto.subtle).
 *
 * Result statuses:
 *   valid        signature checks out, not expired, iat not in the future: payload returned
 *   expired      signature checks out but exp has passed: payload returned, must be shown as UNVERIFIED-CURRENT
 *   invalid      signature or structure wrong, wrong alg or issuer: NO payload, never show data
 *   unknown_key  kid not in the key set: NO payload (connect once to update keys)
 *   future       iat more than 5 minutes ahead (usually a wrong device clock): NO payload
 *   unsupported  genuine signature but a card schema this scanner does not understand: NO payload
 */

export const MAX_IAT_SKEW_SECONDS = 5 * 60;
export const CARD_SCHEMA_VERSION = 1;
export const CARD_ISSUER = 'medistry';

const B64URL = /^[A-Za-z0-9_-]+$/;

function b64urlToBytes(part) {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (part.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(part) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(part)));
}

/**
 * Pulls a compact JWS out of whatever was scanned or pasted: a full URL (…/s#<token>),
 * a bare token, or text with surrounding whitespace. Returns '' if nothing token-shaped is found.
 */
export function extractToken(input) {
  let text = String(input || '').trim();
  const hash = text.indexOf('#');
  if (hash >= 0) text = text.slice(hash + 1);
  try { text = decodeURIComponent(text); } catch { /* keep as is */ }
  text = text.replace(/\s+/g, '');
  const parts = text.split('.');
  return parts.length === 3 && parts.every((p) => B64URL.test(p)) ? text : '';
}

/**
 * Checks an ES256 compact JWS signature against a JWK set. No claims are checked here.
 * @returns {Promise<{status: 'ok'|'invalid'|'unknown_key', header?: object, payload?: object, error?: string, kid?: string}>}
 */
export async function verifySignedToken(token, jwks, opts = {}) {
  const subtle = opts.subtle || globalThis.crypto?.subtle;
  if (!subtle) return { status: 'invalid', error: 'This browser cannot verify signatures (no WebCrypto).' };

  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3 || parts.some((p) => !B64URL.test(p))) return { status: 'invalid', error: 'Not a signed token' };
  const [h, p, s] = parts;

  let header;
  try { header = b64urlJson(h); } catch { return { status: 'invalid', error: 'Unreadable token header' }; }
  if (!header || header.alg !== 'ES256') return { status: 'invalid', error: 'Only ES256 signatures are accepted' };
  if (typeof header.kid !== 'string') return { status: 'invalid', error: 'Token has no key id' };

  const jwk = (Array.isArray(jwks) ? jwks : []).find((k) => k && k.kid === header.kid);
  if (!jwk) return { status: 'unknown_key', kid: header.kid, error: 'Signing key not known to this device' };
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || (jwk.alg && jwk.alg !== 'ES256')) {
    return { status: 'invalid', error: 'Key is not an ES256 P-256 key' };
  }

  let sig;
  try { sig = b64urlToBytes(s); } catch { return { status: 'invalid', error: 'Unreadable signature' }; }
  if (sig.length !== 64) return { status: 'invalid', error: 'Signature has the wrong length' };

  let ok = false;
  try {
    const key = await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, new TextEncoder().encode(`${h}.${p}`));
  } catch {
    ok = false;
  }
  if (!ok) return { status: 'invalid', error: 'Signature does not match: the card has been altered or was not issued by Medistry' };

  let payload;
  try { payload = b64urlJson(p); } catch { return { status: 'invalid', error: 'Unreadable payload' }; }
  return { status: 'ok', header, payload };
}

/**
 * Verifies a card token against a JWK set.
 * @param {string} token compact JWS
 * @param {Array<object>} jwks public keys ({kty, crv, x, y, kid, alg?})
 * @param {{ nowSeconds?: number, subtle?: SubtleCrypto }} [opts]
 * @returns {Promise<{status: string, payload?: object, error?: string, kid?: string}>}
 */
export async function verifyCardToken(token, jwks, opts = {}) {
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const sig = await verifySignedToken(token, jwks, opts);
  if (sig.status !== 'ok') return { status: sig.status, error: sig.error, kid: sig.kid };

  // Only now is the payload trustworthy enough to read.
  const payload = sig.payload;
  if (!payload || payload.iss !== CARD_ISSUER) return { status: 'invalid', error: 'Card was not issued by Medistry' };
  if (payload.typ === 'clinician-pass') return { status: 'invalid', error: 'This is a clinician pass, not a patient card' };
  if (payload.v !== CARD_SCHEMA_VERSION || !payload.e) return { status: 'unsupported', error: `Card format ${payload.v ?? 'legacy'} is not supported by this scanner` };
  if (typeof payload.exp !== 'number') return { status: 'invalid', error: 'Card has no expiry' };
  if (typeof payload.iat === 'number' && payload.iat > now + MAX_IAT_SKEW_SECONDS) {
    return { status: 'future', error: 'Card issue time is in the future. Check this device’s date and time.' };
  }
  if (now >= payload.exp) return { status: 'expired', payload, kid: sig.header.kid };
  return { status: 'valid', payload, kid: sig.header.kid };
}

/**
 * Checks a clinician pass on the device (signature, type, issuer, expiry).
 * @returns {Promise<{status: 'valid'|'expired'|'invalid'|'unknown_key', payload?: object, error?: string}>}
 */
export async function verifyClinicianPass(pass, jwks, opts = {}) {
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const sig = await verifySignedToken(pass, jwks, opts);
  if (sig.status !== 'ok') return { status: sig.status, error: sig.error };
  const p = sig.payload;
  if (!p || p.typ !== 'clinician-pass' || p.iss !== CARD_ISSUER || typeof p.sub !== 'string' || typeof p.dk !== 'string' || typeof p.exp !== 'number') {
    return { status: 'invalid', error: 'Not a clinician pass' };
  }
  if (typeof p.iat === 'number' && p.iat > now + MAX_IAT_SKEW_SECONDS) return { status: 'invalid', error: 'Pass issue time is in the future' };
  if (now >= p.exp) return { status: 'expired', payload: p };
  return { status: 'valid', payload: p };
}
