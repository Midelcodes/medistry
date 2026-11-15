/**
 * Offline scan events: the exact bytes a scanner device signs (ES module, browser and Node).
 * The server imports this same file, so client and server can never disagree on canonical form.
 *
 * Event = { eventId, cardSub, cardVersion, cardKid, reason, details?, scannedAt, pass, deviceSig }
 * deviceSig = ECDSA P-256 / SHA-256 signature (raw r||s, base64url) by the device's non-extractable key
 *             over canonicalJson(the other fields).
 * Card CONTENTS are never part of an event: only the card's subject, version and key id.
 */

export const SCAN_REASONS = ['UNCONSCIOUS', 'LIFE_THREATENING', 'PATIENT_UNABLE_TO_CONSENT', 'OTHER'];
export const SIGNED_EVENT_FIELDS = ['eventId', 'cardSub', 'cardVersion', 'cardKid', 'reason', 'details', 'scannedAt', 'pass'];
export const MAX_BATCH = 50;

/** JSON with object keys sorted at every level and undefined values dropped. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** The string a device signs for an event: only the whitelisted fields, canonical JSON. */
export function eventSigningInput(event) {
  const fields = {};
  for (const k of SIGNED_EVENT_FIELDS) if (event[k] !== undefined && event[k] !== null && event[k] !== '') fields[k] = event[k];
  return canonicalJson(fields);
}

export function bytesToB64url(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Signs an event with a WebCrypto ECDSA P-256 private key and returns the complete event. */
export async function signScanEvent(fields, privateKey, subtle = globalThis.crypto.subtle) {
  const data = new TextEncoder().encode(eventSigningInput(fields));
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data);
  return { ...fields, deviceSig: bytesToB64url(sig) };
}
