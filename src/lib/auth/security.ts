/**
 * MEDISTRY Security & Cryptography Engine
 * Standards-compliant password hashing, TOTP (RFC 6238), and session security.
 */

import crypto from 'node:crypto';

export interface PasswordHashResult {
  hash: string;
  salt: string;
}

export interface SessionTokenPayload {
  userId: string;
  role: string;
  facilityId?: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * High-security password hashing using Scrypt (Argon2-comparable memory-hard KDF).
 * N=32768, r=8, p=1, keylen=64.
 */
/** Minimum password length for clinicians and admins. */
export const MIN_PASSWORD_LENGTH = 12;

export const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1 } as const; // N = 2^15
const SCRYPT_MAXMEM = 128 * 1024 * 1024; // scrypt needs 128 * N * r bytes = 32 MiB at these parameters

export function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex'); // 16-byte salt
    const { N, r, p } = SCRYPT_PARAMS;
    crypto.scrypt(password, salt, 64, { N, r, p, maxmem: SCRYPT_MAXMEM }, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`scrypt$N=${N},r=${r},p=${p}$${salt}$${derivedKey.toString('hex')}`);
    });
  });
}

/**
 * Constant-time password verification. Reads the scrypt parameters stored with the hash (so hashes made with
 * older parameters still verify), within safe bounds, and compares with timingSafeEqual.
 */
export function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const parts = String(storedHash).split('$');
      if (parts.length !== 4 || parts[0] !== 'scrypt') return resolve(false);
      const params = Object.fromEntries(parts[1].split(',').map((kv) => kv.split('=')).map(([k, v]) => [k, Number(v)]));
      const N = params.N, r = params.r, p = params.p;
      const bounded = Number.isInteger(N) && N >= 16384 && N <= 131072 && (N & (N - 1)) === 0 && r === 8 && p === 1;
      if (!bounded) return resolve(false);
      const salt = parts[2];
      const originalKey = Buffer.from(parts[3], 'hex');
      if (!salt || originalKey.length < 32) return resolve(false);
      crypto.scrypt(password, salt, originalKey.length, { N, r, p, maxmem: SCRYPT_MAXMEM }, (err, derivedKey) => {
        if (err || derivedKey.length !== originalKey.length) return resolve(false);
        resolve(crypto.timingSafeEqual(originalKey, derivedKey));
      });
    } catch {
      resolve(false);
    }
  });
}

/** RFC 4648 base32 (A-Z, 2-7, no padding): the encoding authenticator apps expect in otpauth URIs. */
export function toRfc4648Base32(bytes: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

/** Decodes RFC 4648 base32 (case-insensitive, padding and spaces ignored). Throws on other characters. */
export function fromRfc4648Base32(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.toUpperCase().replace(/[\s=]/g, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const v = alphabet.indexOf(ch);
    if (v < 0) throw new Error('Invalid base32 secret');
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * A new TOTP secret for enrolment. `secret` is in this module's internal (Crockford) base32 for verifyTotp;
 * `otpauthUri` carries the SAME bytes in RFC 4648 base32, which authenticator apps require.
 */
export function createTotpEnrolment(accountLabel: string, issuer = 'Medistry'): { secret: string; otpauthUri: string } {
  const bytes = crypto.randomBytes(20);
  const secret = generateTotpSecret(20, bytes);
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountLabel)}`;
  const otpauthUri = `otpauth://totp/${label}?secret=${toRfc4648Base32(bytes)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  return { secret, otpauthUri };
}

/**
 * Crockford Base32 Alphabet (no I, L, O, U to prevent reading ambiguity)
 */
const BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Generates an RFC 6238-compatible Base32 secret for TOTP MFA.
 */
export function generateTotpSecret(byteLength = 20, fixedBytes?: Buffer): string {
  const bytes = fixedBytes && fixedBytes.length >= byteLength ? fixedBytes.subarray(0, byteLength) : crypto.randomBytes(byteLength);
  let base32 = '';
  let bits = 0;
  let value = 0;

  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      base32 += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    base32 += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return base32;
}

/**
 * Decodes a Crockford Base32 string into a Buffer.
 */
function base32ToBuffer(base32: string): Buffer {
  const clean = base32.toUpperCase().replace(/[^0-9A-Z]/g, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    const val = BASE32_ALPHABET.indexOf(char);
    if (val === -1) continue;

    value = (value << 5) | val;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

/**
 * Generates a 6-digit TOTP code for a specific timestamp.
 */
export function generateTotp(secret: string, timestampMs = Date.now(), timeStepSeconds = 30): string {
  const secretBuffer = base32ToBuffer(secret);
  const timeStep = Math.floor(timestampMs / 1000 / timeStepSeconds);
  
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeBigUInt64BE(BigInt(timeStep), 0);

  const hmac = crypto.createHmac('sha1', secretBuffer);
  hmac.update(timeBuffer);
  const digest = hmac.digest();

  // Dynamic truncation (RFC 4226)
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  const otp = (binary % 1000000).toString().padStart(6, '0');
  return otp;
}

/**
 * Verifies a 6-digit TOTP code with +/- 1 window drift tolerance.
 */
export function verifyTotp(
  token: string,
  secret: string,
  timestampMs = Date.now(),
  window = 1,
  timeStepSeconds = 30
): boolean {
  if (!/^\d{6}$/.test(token)) return false;

  for (let drift = -window; drift <= window; drift++) {
    const testTime = timestampMs + drift * timeStepSeconds * 1000;
    const expected = generateTotp(secret, testTime, timeStepSeconds);
    if (crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
      return true;
    }
  }
  return false;
}

/**
 * Creates a cryptographically random, unguessable session token.
 */
export function generateSessionToken(): { rawToken: string; tokenHash: string } {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  return { rawToken, tokenHash };
}

/**
 * Constant-time hash check for lookups and lockout defenses.
 */
export function timingSafeCheck(input: string, target: string): boolean {
  const a = Buffer.from(input);
  const b = Buffer.from(target);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
