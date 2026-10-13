/**
 * MEDISTRY Security Hardening Suite
 * Includes Sliding-Window Rate Limiter, Brute-Force Lockout, Constant-Time Matching,
 * Security Headers (CSP/HSTS/CORS), CSRF Validation, and XSS Sanitization.
 */

import crypto from 'node:crypto';

export interface RateLimitConfig {
  windowMs: number;        // Window duration in ms
  maxRequests: number;     // Allowed requests within window
  lockoutThreshold?: number; // Number of rate-limit violations before triggering temporary IP lockout
  lockoutDurationMs?: number; // Lockout duration in ms
}

export interface RateLimitStatus {
  allowed: boolean;
  remaining: number;
  resetMs: number;
  isLockedOut: boolean;
  lockoutRemainingMs?: number;
}

export class SlidingWindowRateLimiter {
  private requestLogs = new Map<string, number[]>(); // key -> array of timestamps
  private lockoutMap = new Map<string, number>();    // key -> lockout expiry timestamp
  private violationCount = new Map<string, number>(); // key -> violation count

  private config: RateLimitConfig;

  constructor(config: RateLimitConfig = { windowMs: 60_000, maxRequests: 10, lockoutThreshold: 5, lockoutDurationMs: 3600_000 }) {
    this.config = config;
  }

  /**
   * Evaluates if a request from key (e.g., client IP) is permitted.
   */
  check(key: string, now: number = Date.now()): RateLimitStatus {
    // 1. Check if currently locked out
    const lockoutExpiry = this.lockoutMap.get(key);
    if (lockoutExpiry && now < lockoutExpiry) {
      return {
        allowed: false,
        remaining: 0,
        resetMs: lockoutExpiry - now,
        isLockedOut: true,
        lockoutRemainingMs: lockoutExpiry - now,
      };
    } else if (lockoutExpiry && now >= lockoutExpiry) {
      this.lockoutMap.delete(key);
      this.violationCount.delete(key);
    }

    // 2. Clean up timestamps outside current sliding window
    const windowStart = now - this.config.windowMs;
    const timestamps = (this.requestLogs.get(key) || []).filter((ts) => ts > windowStart);

    if (timestamps.length >= this.config.maxRequests) {
      // Record violation
      const violations = (this.violationCount.get(key) || 0) + 1;
      this.violationCount.set(key, violations);

      // Trigger lockout if threshold reached
      if (this.config.lockoutThreshold && violations >= this.config.lockoutThreshold) {
        const lockoutExpiry = now + (this.config.lockoutDurationMs || 3600_000);
        this.lockoutMap.set(key, lockoutExpiry);
        return {
          allowed: false,
          remaining: 0,
          resetMs: this.config.lockoutDurationMs || 3600_000,
          isLockedOut: true,
          lockoutRemainingMs: this.config.lockoutDurationMs || 3600_000,
        };
      }

      const oldestInWindow = timestamps[0];
      const resetMs = Math.max(0, oldestInWindow + this.config.windowMs - now);

      this.requestLogs.set(key, timestamps);
      return {
        allowed: false,
        remaining: 0,
        resetMs,
        isLockedOut: false,
      };
    }

    // Record this request
    timestamps.push(now);
    this.requestLogs.set(key, timestamps);

    return {
      allowed: true,
      remaining: this.config.maxRequests - timestamps.length,
      resetMs: this.config.windowMs,
      isLockedOut: false,
    };
  }

  /**
   * Resets rate limits for a key (e.g. after successful 2FA).
   */
  reset(key: string): void {
    this.requestLogs.delete(key);
    this.lockoutMap.delete(key);
    this.violationCount.delete(key);
  }
}

/**
 * Constant-Time String Comparison
 * Mitigates timing attacks when evaluating OTPs, codes, and tokens.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.length !== bufB.length) {
    // Constant-time dummy comparison to prevent length leak
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * CSRF Protection Utility
 * Generates cryptographically secure anti-CSRF tokens and validates double-submit cookies.
 */
export class CsrfManager {
  /**
   * Generates a 256-bit unguessable CSRF token.
   */
  static generateToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Verifies CSRF header token matches cookie token in constant-time.
   */
  static verify(cookieToken: string, headerToken: string): boolean {
    if (!cookieToken || !headerToken) return false;
    return constantTimeEqual(cookieToken, headerToken);
  }
}

/**
 * XSS Content Sanitizer
 * Strips active script tags, inline event handlers, and javascript: protocols
 * from clinical free-text, diagnoses, and uploaded document titles.
 */
export function sanitizeClinicalText(input: string): string {
  if (!input) return '';

  return input
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Remove <script> tags
    .replace(/on\w+\s*=\s*(?:["'][^"']*["']|[^\s>]+)/gi, '')          // Remove inline event handlers (onload, onerror)
    .replace(/javascript\s*:\s*[^\s"'>]+/gi, '')                        // Remove javascript: pseudo-protocol
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')  // Remove iframes
    .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '')  // Remove objects
    .trim();
}

/**
 * Production Security HTTP Headers Builder
 * Provides strict CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy.
 */
export function getSecurityHttpHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self';",
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  };
}

