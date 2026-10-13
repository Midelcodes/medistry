/**
 * MEDISTRY Emergency Code Security Guard
 * Enforces rate limiting, brute-force enumeration lockout, constant-time lookups,
 * and audit logging for every code scan attempt.
 */

import crypto from 'node:crypto';
import { hashEmergencyCode } from './crockford.ts';
import { EmergencyCodeLifecycleManager } from './lifecycle.ts';
import { AuditChainManager } from '../audit/hashChain.ts';

export interface ScanAttemptRequest {
  code: string;
  ipAddress: string;
  userAgent: string;
  scannerUserId?: string;
}

export interface SecurityGuardConfig {
  maxAttempts: number;      // default: 5
  windowMs: number;         // default: 15 minutes (900,000 ms)
  lockoutDurationMs: number;// default: 1 hour (3,600,000 ms)
}

export const DEFAULT_GUARD_CONFIG: SecurityGuardConfig = {
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
  lockoutDurationMs: 60 * 60 * 1000,
};

interface AttemptRecord {
  count: number;
  firstAttemptAt: number;
  lockedUntil?: number;
}

export class CodeSecurityGuard {
  private ipAttempts = new Map<string, AttemptRecord>();
  private lifecycleManager: EmergencyCodeLifecycleManager;
  private auditManager: AuditChainManager;
  private config: SecurityGuardConfig;

  constructor(
    lifecycleManager: EmergencyCodeLifecycleManager,
    auditManager: AuditChainManager,
    config: SecurityGuardConfig = DEFAULT_GUARD_CONFIG
  ) {
    this.lifecycleManager = lifecycleManager;
    this.auditManager = auditManager;
    this.config = config;
  }

  /**
   * Evaluates if the IP is currently locked out from scanning.
   */
  isIpLockedOut(ipAddress: string, now = Date.now()): { locked: boolean; remainingSeconds?: number } {
    const record = this.ipAttempts.get(ipAddress);
    if (!record || !record.lockedUntil) {
      return { locked: false };
    }

    if (now < record.lockedUntil) {
      const remainingSeconds = Math.ceil((record.lockedUntil - now) / 1000);
      return { locked: true, remainingSeconds };
    }

    // Lockout has expired, reset counter
    this.ipAttempts.delete(ipAddress);
    return { locked: false };
  }

  /**
   * Records a failed scan attempt and evaluates if lockout threshold has been breached.
   */
  private recordFailure(ipAddress: string, now = Date.now()): { locked: boolean; remainingAttempts: number } {
    const record = this.ipAttempts.get(ipAddress) || { count: 0, firstAttemptAt: now };

    // Reset window if elapsed
    if (now - record.firstAttemptAt > this.config.windowMs) {
      record.count = 0;
      record.firstAttemptAt = now;
    }

    record.count++;

    if (record.count >= this.config.maxAttempts) {
      record.lockedUntil = now + this.config.lockoutDurationMs;
      this.ipAttempts.set(ipAddress, record);
      return { locked: true, remainingAttempts: 0 };
    }

    this.ipAttempts.set(ipAddress, record);
    return { locked: false, remainingAttempts: this.config.maxAttempts - record.count };
  }

  /**
   * Resets failure counter upon an authenticated successful scan.
   */
  private recordSuccess(ipAddress: string) {
    this.ipAttempts.delete(ipAddress);
  }

  /**
   * Constant-time resolution of a scanned code with rate-limit and enumeration defenses.
   */
  processScanAttempt(req: ScanAttemptRequest, now = Date.now()): {
    allowed: boolean;
    status: 'SUCCESS' | 'LOCKED_OUT' | 'NOT_FOUND' | 'REVOKED';
    statusCode: 200 | 404 | 410 | 429;
    patientId?: string;
    message: string;
  } {
    const { code, ipAddress, userAgent, scannerUserId } = req;

    // 1. Check for active IP lockout
    const lockoutCheck = this.isIpLockedOut(ipAddress, now);
    if (lockoutCheck.locked) {
      this.auditManager.appendEntry({
        actorId: scannerUserId || 'ANONYMOUS',
        action: 'EMERGENCY_CODE_SCAN_BLOCKED_LOCKOUT',
        accessType: 'EMERGENCY_BREAK_GLASS',
        ipAddress,
        userAgent,
        reason: `Scan rejected: IP locked out for ${lockoutCheck.remainingSeconds}s`,
      });

      return {
        allowed: false,
        status: 'LOCKED_OUT',
        statusCode: 429,
        message: `Too many failed scan attempts. Device is locked out for ${lockoutCheck.remainingSeconds} seconds.`,
      };
    }

    // 2. Resolve code using constant-time hash resolution
    const resolution = this.lifecycleManager.resolveActiveCode(code);

    // 3. Code is revoked
    if (resolution.isRevoked) {
      this.recordFailure(ipAddress, now);
      this.auditManager.appendEntry({
        actorId: scannerUserId || 'ANONYMOUS',
        subjectId: resolution.patientId,
        action: 'EMERGENCY_CODE_SCAN_REVOKED',
        accessType: 'EMERGENCY_BREAK_GLASS',
        ipAddress,
        userAgent,
        reason: 'Scanned emergency card was revoked by patient',
      });

      return {
        allowed: false,
        status: 'REVOKED',
        statusCode: 410,
        message: 'This emergency card has been revoked and is no longer valid.',
      };
    }

    // 4. Code does not exist (Enumeration attempt)
    if (!resolution.valid || !resolution.patientId) {
      const failureResult = this.recordFailure(ipAddress, now);
      this.auditManager.appendEntry({
        actorId: scannerUserId || 'ANONYMOUS',
        action: 'EMERGENCY_CODE_SCAN_NOT_FOUND',
        accessType: 'EMERGENCY_BREAK_GLASS',
        ipAddress,
        userAgent,
        reason: failureResult.locked
          ? 'Invalid code; threshold exceeded, IP locked out'
          : `Invalid code attempt (${failureResult.remainingAttempts} attempts remaining)`,
      });

      if (failureResult.locked) {
        return {
          allowed: false,
          status: 'LOCKED_OUT',
          statusCode: 429,
          message: 'Too many invalid attempts. Your device has been locked out for 1 hour.',
        };
      }

      return {
        allowed: false,
        status: 'NOT_FOUND',
        statusCode: 404,
        message: 'Emergency code not found. Please verify the code and try again.',
      };
    }

    // 5. Successful code resolution
    this.recordSuccess(ipAddress);
    this.auditManager.appendEntry({
      actorId: scannerUserId || 'ANONYMOUS',
      subjectId: resolution.patientId,
      action: 'EMERGENCY_CODE_SCAN_SUCCESS',
      accessType: 'EMERGENCY_BREAK_GLASS',
      ipAddress,
      userAgent,
      reason: 'Valid emergency card scanned; gateway loaded',
    });

    return {
      allowed: true,
      status: 'SUCCESS',
      statusCode: 200,
      patientId: resolution.patientId,
      message: 'Emergency code verified. Proceeding to break-glass gateway.',
    };
  }
}
