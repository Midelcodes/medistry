/**
 * Offline emergency card keys (ES256: ECDSA P-256 with SHA-256).
 * Scanners verify cards offline with the PUBLIC key only, so a scanner can never forge a card.
 * - OFFLINE_CARD_PRIVATE_KEY: PKCS8 private key as PEM, base64 of the PEM, or base64 of the DER
 *   (`node scripts/gen-card-key.mjs` prints one).
 * - OFFLINE_CARD_PREVIOUS_PUBLIC_KEYS: optional comma-separated SPKI public keys (same encodings)
 *   that are still published for verification after a key rotation. Each may end in "@<date>"
 *   (ISO 8601): the key leaves the JWKS after that date, i.e. once every card it signed has expired.
 *   Without a date the key stays published.
 * The module-level helpers below go through the KeyProvider (crypto/keyProvider.ts).
 * Missing or invalid key: a random per-process key in dev/demo (cards from a previous run stop
 * verifying), and a thrown error in production with DEMO_MODE=0 (fail closed), like appSecret().
 */
import crypto, { type KeyObject } from 'node:crypto';
import { keyProvider } from './keyProvider.ts';

export interface CardJwk extends JsonWebKey {
  kid: string;
  alg: 'ES256';
  use: 'sig';
}

export interface CompactJwsVerification {
  valid: boolean;
  payload?: Record<string, any>;
  error?: string;
}

export interface CardKeyStore {
  signCompactJws(payload: object): string;
  getPublicJwk(): CardJwk;
  /** Current key first, then previous keys still within their keep-until date. */
  getPublicJwks(nowSeconds?: number): CardJwk[];
  getKid(): string;
}

const MAX_IAT_SKEW_SECONDS = 5 * 60;
export const SIGNATURE_MISMATCH = 'Cryptographic signature mismatch: offline card has been altered';

const b64url = (buf: Buffer) => buf.toString('base64url');

/** RFC 7638 JWK thumbprint (SHA-256, base64url) of an EC public key. */
export function jwkThumbprint(jwk: JsonWebKey): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return b64url(crypto.createHash('sha256').update(canonical, 'utf8').digest());
}

function assertP256(key: KeyObject, what: string): void {
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error(`${what} must be an EC P-256 key`);
  }
}

/** Accepts PEM, base64 of a PEM, or base64 DER. */
function decodeKeyMaterial(value: string): { pem?: string; der?: Buffer } {
  const v = value.trim();
  if (v.includes('-----BEGIN')) return { pem: v.replace(/\\n/g, '\n') };
  const raw = Buffer.from(v, 'base64');
  if (!raw.length) throw new Error('empty key');
  const asText = raw.toString('utf8');
  return asText.includes('-----BEGIN') ? { pem: asText } : { der: raw };
}

export function parsePrivateKey(value: string): KeyObject {
  const { pem, der } = decodeKeyMaterial(value);
  const key = pem ? crypto.createPrivateKey(pem) : crypto.createPrivateKey({ key: der!, format: 'der', type: 'pkcs8' });
  assertP256(key, 'OFFLINE_CARD_PRIVATE_KEY');
  return key;
}

export function parsePublicKey(value: string): KeyObject {
  const { pem, der } = decodeKeyMaterial(value);
  const key = pem ? crypto.createPublicKey(pem) : crypto.createPublicKey({ key: der!, format: 'der', type: 'spki' });
  assertP256(key, 'OFFLINE_CARD_PREVIOUS_PUBLIC_KEYS entry');
  return key;
}

function toCardJwk(publicKey: KeyObject): CardJwk {
  const { kty, crv, x, y } = publicKey.export({ format: 'jwk' });
  const base = { kty, crv, x, y };
  return { ...base, kid: jwkThumbprint(base), alg: 'ES256', use: 'sig' };
}

/** A previous public key and, optionally, the time (seconds) after which it is no longer published. */
export type PreviousCardKey = KeyObject | { key: KeyObject; keepUntil?: number };

/** Builds a key store from a private key (and optional previous public keys for rotation). */
export function createCardKeyStore(privateKey: KeyObject, previousPublicKeys: PreviousCardKey[] = []): CardKeyStore {
  assertP256(privateKey, 'Card signing key');
  const current = toCardJwk(crypto.createPublicKey(privateKey));
  const previous = previousPublicKeys
    .map((p) => ('key' in p && !(p as KeyObject).type ? p as { key: KeyObject; keepUntil?: number } : { key: p as KeyObject }))
    .map((p) => ({ jwk: toCardJwk(p.key), keepUntil: p.keepUntil }))
    .filter((p) => p.jwk.kid !== current.kid);
  return {
    signCompactJws(payload: object): string {
      const header = { alg: 'ES256', typ: 'JWT', kid: current.kid };
      const input = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
      const signature = crypto.sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' });
      return `${input}.${b64url(signature)}`;
    },
    getPublicJwk: () => ({ ...current }),
    getPublicJwks: (nowSeconds = Math.floor(Date.now() / 1000)) => [
      { ...current },
      ...previous.filter((p) => p.keepUntil === undefined || p.keepUntil > nowSeconds).map((p) => ({ ...p.jwk })),
    ],
    getKid: () => current.kid,
  };
}

/**
 * Loads the store from an environment. Exported for tests; the app uses the module-level functions.
 */
export function loadCardKeyStore(env: NodeJS.ProcessEnv = process.env): CardKeyStore {
  const failClosed = env.NODE_ENV === 'production' && env.DEMO_MODE === '0';
  const raw = (env.OFFLINE_CARD_PRIVATE_KEY || '').trim();
  let privateKey: KeyObject | null = null;
  let problem = raw ? '' : 'not set';
  if (raw) {
    try {
      privateKey = parsePrivateKey(raw);
    } catch {
      problem = 'invalid (expected a PKCS8 EC P-256 private key)';
    }
  }
  if (!privateKey) {
    if (failClosed) {
      throw new Error(`OFFLINE_CARD_PRIVATE_KEY is ${problem}. Generate one with: node scripts/gen-card-key.mjs (required when DEMO_MODE=0 in production).`);
    }
    privateKey = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    console.warn(`[security] OFFLINE_CARD_PRIVATE_KEY is ${problem}; using a random per-process P-256 key. Offline cards stop verifying after a restart. Generate one with: node scripts/gen-card-key.mjs`);
  }

  const previous: PreviousCardKey[] = [];
  for (const entry of (env.OFFLINE_CARD_PREVIOUS_PUBLIC_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    try {
      const [keyText, until] = entry.split('@');
      const keepUntil = until ? Date.parse(until.trim()) : undefined;
      if (until && Number.isNaN(keepUntil)) throw new Error('bad date');
      previous.push({ key: parsePublicKey(keyText), keepUntil: keepUntil === undefined ? undefined : Math.floor(keepUntil / 1000) });
    } catch (err) {
      if (failClosed) throw new Error('OFFLINE_CARD_PREVIOUS_PUBLIC_KEYS contains an invalid entry (expected SPKI EC P-256, optionally @<ISO date>).');
      console.warn('[security] Ignoring an invalid entry in OFFLINE_CARD_PREVIOUS_PUBLIC_KEYS.');
    }
  }
  return createCardKeyStore(privateKey, previous);
}

// Process-wide helpers: card signing and the published keys, through the KeyProvider.
export const signCompactJws = (payload: object): string => keyProvider().signCard(payload);
export const getPublicJwks = (nowSeconds?: number): CardJwk[] => keyProvider().getCardJwks(nowSeconds);
export const getPublicJwk = (): CardJwk => getPublicJwks()[0];
export const getKid = (): string => keyProvider().getCardKid();

/**
 * Verifies an ES256 compact JWS against a JWK set. Only ES256 is accepted (no algorithm confusion),
 * the key is chosen by kid, `exp` is required and checked, and `iat` may be at most 5 minutes ahead.
 */
export function verifyCompactJws(token: string, jwks: JsonWebKey[], nowSeconds = Math.floor(Date.now() / 1000)): CompactJwsVerification {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) {
    return { valid: false, error: 'Malformed token structure' };
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  let header: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
  } catch {
    return { valid: false, error: 'Malformed token header' };
  }
  if (header.alg !== 'ES256') return { valid: false, error: `Unsupported algorithm: only ES256 is accepted` };
  if (typeof header.kid !== 'string') return { valid: false, error: 'Token has no key id (kid)' };

  const jwk = jwks.find((k) => (k as CardJwk).kid === header.kid);
  if (!jwk) return { valid: false, error: 'Unknown signing key (kid)' };
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || (jwk.alg && jwk.alg !== 'ES256')) {
    return { valid: false, error: 'Signing key is not an ES256 P-256 key' };
  }

  const signature = Buffer.from(encodedSignature, 'base64url');
  if (signature.length !== 64) return { valid: false, error: SIGNATURE_MISMATCH };

  let ok = false;
  try {
    const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
    ok = crypto.verify('sha256', Buffer.from(`${encodedHeader}.${encodedPayload}`), { key, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    ok = false;
  }
  if (!ok) return { valid: false, error: SIGNATURE_MISMATCH };

  let payload: Record<string, any>;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return { valid: false, error: 'Failed to parse payload JSON' };
  }
  if (typeof payload.exp !== 'number') return { valid: false, error: 'Offline emergency card has no expiry' };
  if (nowSeconds >= payload.exp) return { valid: false, error: 'Offline emergency card signature has expired' };
  if (typeof payload.iat === 'number' && payload.iat > nowSeconds + MAX_IAT_SKEW_SECONDS) {
    return { valid: false, error: 'Offline emergency card was issued in the future' };
  }
  return { valid: true, payload };
}
