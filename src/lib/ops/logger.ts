/**
 * Structured JSON logs (Phase 14): one JSON object per line with ts, level, event and fields. Every log line
 * passes through redact(), which removes phone numbers and other long digit runs (NIN), emails, emergency codes,
 * bearer and JWS/session tokens from strings, and blanks whole fields whose name says they hold personal data
 * (names, contact details, codes, secrets, free text).
 */
import crypto from 'node:crypto';

const SENSITIVE_KEYS = new Set([
  'name', 'firstname', 'lastname', 'fullname', 'patientname', 'doctorname', 'clinicianname', 'email', 'phone', 'phonenumber',
  'to', 'nin', 'dob', 'dateofbirth', 'address', 'token', 'pass', 'authorization', 'cookie', 'setcookie', 'password', 'otp', 'pin',
  'code', 'emergencycode', 'formattedcode', 'rawcode', 'secret', 'apikey', 'message', 'body', 'text', 'reason', 'note', 'details',
]);

const CROCKFORD = '[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]';
const PATTERNS: Array<[RegExp, string | ((m: string) => string)]> = [
  [/\bBearer\s+\S+/gi, 'Bearer [REDACTED]'],
  // JWS/JWT (three base64url parts) and session tokens (two long base64url parts)
  [/\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]{16,})?\b/g, '[REDACTED_TOKEN]'],
  [/[^\s@"'<>]+@[^\s@"'<>]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]'],
  // Emergency codes: Crockford groups 4-4-4-2..4 (e.g. K7QM-4T9X-2HDP-8W2)
  [new RegExp(`\\b${CROCKFORD}{4}-${CROCKFORD}{4}-${CROCKFORD}{4}-${CROCKFORD}{2,4}\\b`, 'g'), '[REDACTED_CODE]'],
  // Phone numbers, NIN and other runs of 7+ digits (spaces, dots, dashes, brackets allowed); dates are kept
  [/\+?\d[\d\s().-]{5,}\d/g, (m) => (/^\d{4}-\d{2}-\d{2}/.test(m) || m.replace(/\D/g, '').length < 7 ? m : '[REDACTED_NUMBER]')],
];

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function redactString(s: string): string {
  // Random ids (request ids, record ids) are kept intact: set them aside so the digit rule cannot cut them.
  const ids: string[] = [];
  let out = s.replace(UUID, (m) => `\u0000${ids.push(m) - 1}\u0000`);
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep as string);
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => ids[Number(i)]);
}

/** Copy of `value` with personal data removed (strings scrubbed, sensitive keys blanked). */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { error: redactString(value.message), name: value.name };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase().replace(/[^a-z]/g, '')) && v !== undefined && v !== null ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

export type LogLevel = 'info' | 'warn' | 'error';

/** One JSON log line. Fields are redacted; never pass secrets or request bodies anyway. */
export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...(redact(fields) as Record<string, unknown>) });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** The caller's X-Request-Id if it is a plain token (8-64 of [A-Za-z0-9_-]), else a new UUID. */
export function requestIdFrom(header: string | string[] | undefined): string {
  const v = Array.isArray(header) ? header[0] : header;
  return v && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : crypto.randomUUID();
}
