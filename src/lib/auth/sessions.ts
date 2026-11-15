/**
 * Signed session tokens for every kind of signed-in user (clinicians, admins, patients and proxies).
 *
 * A token is base64url(JSON {k: kind, s: subject, e: expiry, t: issued, j: token id}) + "." + HMAC-SHA256 of it,
 * keyed from JWT_SECRET. It travels in the Authorization: Bearer header for API calls; the HttpOnly,
 * SameSite=Strict cookie is accepted only for read-only page navigations. Because state-changing API calls
 * need the Bearer header, which a cross-site page cannot set, cookies cannot be used for CSRF.
 *
 * Revocation: "sign out everywhere" and account recovery set the account's sessionsNotBefore; any token issued
 * before it is refused. Signing out revokes the one token id until it would have expired anyway.
 */
import crypto from 'node:crypto';

export type SessionKind = 'clinician' | 'admin' | 'person';

export interface SessionClaims {
  kind: SessionKind;
  subject: string;
  issuedAt: number;
  expiresAt: number;
  tokenId: string;
}

export class SessionManager {
  private revokedTokens = new Map<string, number>(); // token id -> expiry (ms)
  private serverKey: string;
  /** Returns the time (ms) before which this subject's tokens are void, if any. */
  notBefore: (kind: SessionKind, subject: string) => number | undefined = () => undefined;

  constructor(serverKey: string) {
    this.serverKey = serverKey;
  }

  private sign(payload: string): Buffer {
    return crypto.createHmac('sha256', this.serverKey).update(`session:${payload}`).digest();
  }

  issue(kind: SessionKind, subject: string, ttlMs: number, now = Date.now()): string {
    const payload = Buffer.from(JSON.stringify({ k: kind, s: subject, e: now + ttlMs, t: now, j: crypto.randomBytes(9).toString('base64url') })).toString('base64url');
    return `${payload}.${this.sign(payload).toString('base64url')}`;
  }

  read(token: string, now = Date.now()): SessionClaims | null {
    const [payload, sig] = String(token || '').split('.');
    if (!payload || !sig) return null;
    const expected = this.sign(payload);
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    let data: any;
    try {
      data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    } catch {
      return null;
    }
    if (!['clinician', 'admin', 'person'].includes(data.k) || typeof data.s !== 'string' || !(data.e > now)) return null;
    if (this.revokedTokens.has(data.j)) return null;
    const notBefore = this.notBefore(data.k, data.s);
    if (notBefore !== undefined && data.t < notBefore) return null;
    return { kind: data.k, subject: data.s, issuedAt: data.t, expiresAt: data.e, tokenId: data.j };
  }

  /** Revokes one token (sign out on this device). */
  revokeToken(claims: SessionClaims, now = Date.now()): void {
    for (const [id, exp] of this.revokedTokens) if (exp <= now) this.revokedTokens.delete(id);
    this.revokedTokens.set(claims.tokenId, claims.expiresAt);
  }
}
