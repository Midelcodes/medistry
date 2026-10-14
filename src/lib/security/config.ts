/**
 * Runtime security configuration shared by the server and libraries.
 * - appSecret(): never falls back to a secret that is published in this repository.
 * - DEMO_MODE: the unauthenticated patient directory and patient portal exist only for the demo.
 * - clientIp(): proxy-aware client address for rate limiting.
 */
import crypto from 'node:crypto';
import type http from 'node:http';

export const DEMO_MODE = process.env.DEMO_MODE !== '0';
export const SESSION_COOKIE = 'medistry_session';
export const SESSION_TTL_MS = Math.max(1, parseInt(process.env.SESSION_TIMEOUT_MINUTES || '15', 10) || 15) * 60_000;

// Values that appear in the public repo and must never be trusted as secrets.
const PUBLISHED_VALUES = new Set([
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  'super_secret_jwt_hmac_key_min_32_characters_long_for_security',
  'offline_ecdsa_or_hmac_signing_key_for_emergency_qr_cards',
  'medistry-dev-only-secret-change-me-in-production',
  'offline_emergency_signing_key_secret_2026',
]);

const ephemeral = new Map<string, string>();

/**
 * Returns the named secret from the environment. If it is missing, too short, or a published default,
 * a random per-process value is used instead (sessions then reset on restart). Outside demo mode in
 * production this throws, so the server fails closed.
 */
export function appSecret(name: string, opts: { hex?: boolean } = {}): string {
  const value = (process.env[name] || '').trim();
  const strong = opts.hex ? /^[0-9a-fA-F]{64}$/.test(value) : value.length >= 32;
  if (value && strong && !PUBLISHED_VALUES.has(value)) return value;

  if (process.env.NODE_ENV === 'production' && !DEMO_MODE) {
    throw new Error(`${name} must be set to a strong, private value (openssl rand -hex 32) when DEMO_MODE=0 in production.`);
  }
  let generated = ephemeral.get(name);
  if (!generated) {
    generated = crypto.randomBytes(32).toString('hex');
    ephemeral.set(name, generated);
    console.warn(`[security] ${name} is ${value ? 'weak or a published default' : 'not set'}; using a random per-process value. Set a strong ${name} (openssl rand -hex 32) to keep sessions across restarts.`);
  }
  return generated;
}

const TRUST_PROXY = process.env.TRUST_PROXY === '1' || !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RAILWAY_PROJECT_ID;

/** Client address for rate limiting. Behind one trusted proxy the rightmost X-Forwarded-For entry is the real client. */
export function clientIp(req: http.IncomingMessage): string {
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress || '127.0.0.1';
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
