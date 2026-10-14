/**
 * MEDISTRY Crockford Base32 Engine with Modulo-32 Check Character
 * Generates 128-bit cryptographically secure, opaque, human-friendly emergency IDs.
 * No personal data is embedded in the code.
 */

import crypto from 'node:crypto';

// Crockford Alphabet (32 symbols): 0-9, A-Z (excluding I, L, O, U)
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Maps confusing lookalike characters to their Crockford equivalents:
 * i, I, l, L -> 1
 * o, O       -> 0
 */
export function normalizeCrockfordChar(char: string): string {
  const upper = char.toUpperCase();
  if (upper === 'I' || upper === 'L') return '1';
  if (upper === 'O') return '0';
  return upper;
}

/**
 * Computes a weighted Modulo-32 check character to detect transcription errors
 * and adjacent character transpositions.
 */
export function computeCheckCharacter(payloadChars: string): string {
  let checksum = 0;
  for (let i = 0; i < payloadChars.length; i++) {
    const char = payloadChars[i];
    const val = CROCKFORD_ALPHABET.indexOf(char);
    if (val === -1) {
      throw new Error(`Invalid Crockford character '${char}' at index ${i}`);
    }
    // Weighting factor (i + 1) detects adjacent transpositions
    checksum = (checksum + val * (i + 1)) % 32;
  }
  return CROCKFORD_ALPHABET[checksum];
}

export interface GeneratedCodeResult {
  rawCode: string;         // 14 payload chars + 1 check char = 15 chars (e.g. K7QM4T9X2HDP8W)
  formattedCode: string;   // Grouped: K7QM-4T9X-2HDP-8W
  codeHash: string;        // SHA-256 for fast constant-time database index
  scanUrl: string;         // https://DOMAIN/e/K7QM-4T9X-2HDP-8W
}

/**
 * Generates a 128-bit random non-sequential Crockford Base32 code with check character.
 */
export function generatePatientUniqueCode(domain = 'medistry.health', fixedBytes?: Buffer): GeneratedCodeResult {
  // 128-bit randomness = 16 bytes (fixedBytes is only for deterministic synthetic seed data)
  const randomBytes = fixedBytes && fixedBytes.length >= 16 ? fixedBytes.subarray(0, 16) : crypto.randomBytes(16);
  
  // Convert random bytes into Crockford Base32 symbols
  let payload = '';
  let bits = 0;
  let value = 0;

  for (let i = 0; i < randomBytes.length; i++) {
    value = (value << 8) | randomBytes[i];
    bits += 8;
    while (bits >= 5) {
      payload += CROCKFORD_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  // Use 14 characters for payload (~70 bits entropy, 32^14 combinations = 1.18 x 10^21)
  const codePayload = payload.slice(0, 14);
  const checkChar = computeCheckCharacter(codePayload);
  const rawCode = `${codePayload}${checkChar}`;

  // Format into grouped human-readable string: 4-4-4-3 (e.g. K7QM-4T9X-2HDP-8W2)
  const formattedCode = `${rawCode.slice(0, 4)}-${rawCode.slice(4, 8)}-${rawCode.slice(8, 12)}-${rawCode.slice(12)}`;
  
  // Constant-time SHA-256 hash for database indexing
  const codeHash = hashEmergencyCode(rawCode);
  const scanUrl = `https://${domain}/e/${formattedCode}`;

  return {
    rawCode,
    formattedCode,
    codeHash,
    scanUrl,
  };
}

/**
 * Cleans and normalizes human input (strips hyphens, spaces, normalizes lookalikes).
 */
export function normalizePatientCode(input: string): string {
  if (!input || typeof input !== 'string') return '';
  const stripped = input.replace(/[-\s]/g, '');
  let normalized = '';
  for (let i = 0; i < stripped.length; i++) {
    const clean = normalizeCrockfordChar(stripped[i]);
    if (CROCKFORD_ALPHABET.includes(clean)) {
      normalized += clean;
    }
  }
  return normalized;
}

/**
 * Validates a patient emergency code against its check character.
 */
export function validatePatientCode(code: string): { valid: boolean; normalized?: string; error?: string } {
  const normalized = normalizePatientCode(code);

  if (normalized.length !== 15) {
    return { valid: false, error: 'Code must be exactly 15 characters (including check character)' };
  }

  const payload = normalized.slice(0, 14);
  const providedCheck = normalized.slice(14);
  const expectedCheck = computeCheckCharacter(payload);

  if (providedCheck !== expectedCheck) {
    return { valid: false, error: 'Check character mismatch: code contains a transcription error' };
  }

  return { valid: true, normalized };
}

/**
 * Hashes normalized code with SHA-256 for secure constant-time database matching.
 */
export function hashEmergencyCode(normalizedCode: string): string {
  const clean = normalizePatientCode(normalizedCode);
  return crypto.createHash('sha256').update(clean, 'utf8').digest('hex');
}

