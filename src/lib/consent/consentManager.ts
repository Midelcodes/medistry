/**
 * MEDISTRY Cross-Hospital Access Request & Consent Lifecycle Manager
 * Handles: Patient lookup, access requests, in-app/OTP approvals, pre-shared links,
 * instant revocation, and central policy synchronization.
 */

import crypto from 'node:crypto';
import { hashEmergencyCode } from '../code/crockford.ts';
import { decryptPatientDemographics, type PatientEntity } from '../patient/profile.ts';
import { AuditChainManager } from '../audit/hashChain.ts';
import type { ConsentContext } from '../policy/enforcer.ts';

export type ConsentDurationPreset = 'ONE_VISIT' | 'SEVEN_DAYS' | 'THIRTY_DAYS' | 'CUSTOM';

export interface PendingAccessRequest {
  id: string;
  patientId: string;
  requestingClinicianId: string;
  requestingClinicianName: string;
  requestingFacilityId: string;
  requestingFacilityName: string;
  requestedScopes: string[]; // ['all'] or ['Condition', 'MedicationStatement']
  durationPreset: ConsentDurationPreset;
  durationHours: number;
  clinicalReason: string;
  hashedOtp: string;         // SHA-256 of 6-digit OTP
  otpExpiresAt: number;      // Timestamp
  otpAttemptsRemaining: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  createdAt: string;
}

export interface StoredConsentGrant extends ConsentContext {
  requestingClinicianName: string;
  requestingFacilityName: string;
  clinicalReason: string;
  createdAt: string;
  revocationReason?: string;
  revokedAt?: string;
}

export interface PreSharedLinkToken {
  token: string;
  patientId: string;
  targetFacilityId: string;
  scopes: string[];
  expiresAt: string;
  nonce: string;
}

export class ConsentLifecycleManager {
  private pendingRequests = new Map<string, PendingAccessRequest>(); // Key: requestId
  private activeGrants = new Map<string, StoredConsentGrant>();        // Key: grantId
  private patientGrants = new Map<string, string[]>();                // Key: patientId -> grantId[]
  private auditManager: AuditChainManager;

  constructor(auditManager: AuditChainManager) {
    this.auditManager = auditManager;
  }

  /**
   * Helper: calculates hours from preset
   */
  private presetToHours(preset: ConsentDurationPreset, customHours?: number): number {
    switch (preset) {
      case 'ONE_VISIT': return 24;
      case 'SEVEN_DAYS': return 168;
      case 'THIRTY_DAYS': return 720;
      case 'CUSTOM': return customHours || 24;
    }
  }

  /**
   * 1. Safe Patient Lookup: Allows clinician at Hospital B to verify they are requesting
   * access for the correct patient without exposing sensitive PII prior to consent.
   */
  lookupPatientSafe(
    query: { code?: string; patientId?: string; dateOfBirth?: string },
    patientDatabase: Map<string, PatientEntity>,
    codeResolver: (code: string) => { valid: boolean; patientId?: string }
  ): { found: boolean; patientId?: string; redactedPreview?: { initials: string; birthYear: string; gender: string } } {
    let targetPatientId: string | undefined;

    if (query.code) {
      const resolved = codeResolver(query.code);
      if (resolved.valid) {
        targetPatientId = resolved.patientId;
      }
    } else if (query.patientId && query.dateOfBirth) {
      const candidate = patientDatabase.get(query.patientId);
      if (candidate) {
        const decrypted = decryptPatientDemographics(candidate);
        if (decrypted.dateOfBirth === query.dateOfBirth) {
          targetPatientId = candidate.id;
        }
      }
    }

    if (!targetPatientId) {
      return { found: false };
    }

    const patient = patientDatabase.get(targetPatientId);
    if (!patient) return { found: false };

    const demo = decryptPatientDemographics(patient);
    const initials = `${demo.firstName.charAt(0)}. ${demo.lastName.charAt(0)}.`;
    const birthYear = demo.dateOfBirth.split('-')[0] || '****';

    return {
      found: true,
      patientId: patient.id,
      redactedPreview: {
        initials,
        birthYear,
        gender: patient.gender.toUpperCase(),
      },
    };
  }

  /**
   * 2. Initiates a Cross-Hospital Record Access Request.
   * Generates in-app request and a 6-digit OTP for SMS/Email fallback verification.
   */
  createAccessRequest(req: {
    patientId: string;
    clinicianId: string;
    clinicianName: string;
    facilityId: string;
    facilityName: string;
    requestedScopes: string[];
    durationPreset: ConsentDurationPreset;
    customHours?: number;
    clinicalReason: string;
  }): { requestId: string; rawOtp: string; expiresAt: number } {
    const rawOtp = crypto.randomInt(100000, 999999).toString();
    const hashedOtp = crypto.createHash('sha256').update(rawOtp).digest('hex');
    const requestId = crypto.randomUUID();
    const now = Date.now();
    const otpExpiresAt = now + 10 * 60 * 1000; // 10 minutes OTP validity

    const durationHours = this.presetToHours(req.durationPreset, req.customHours);

    const pending: PendingAccessRequest = {
      id: requestId,
      patientId: req.patientId,
      requestingClinicianId: req.clinicianId,
      requestingClinicianName: req.clinicianName,
      requestingFacilityId: req.facilityId,
      requestingFacilityName: req.facilityName,
      requestedScopes: req.requestedScopes.length ? req.requestedScopes : ['all'],
      durationPreset: req.durationPreset,
      durationHours,
      clinicalReason: req.clinicalReason,
      hashedOtp,
      otpExpiresAt,
      otpAttemptsRemaining: 3,
      status: 'PENDING',
      createdAt: new Date(now).toISOString(),
    };

    this.pendingRequests.set(requestId, pending);

    // Audit event
    this.auditManager.appendEntry({
      actorId: req.clinicianId,
      subjectId: req.patientId,
      action: 'CONSENT_ACCESS_REQUEST_CREATED',
      accessType: 'NORMAL_CONSENT',
      facilityId: req.facilityId,
      ipAddress: '127.0.0.1',
      userAgent: 'ClinicalClient/1.0',
      reason: `Access requested by ${req.clinicianName} (${req.facilityName}): ${req.clinicalReason}`,
    });

    return { requestId, rawOtp, expiresAt: otpExpiresAt };
  }

  /**
   * 3A. In-App Approval by Patient.
   * Patient can approve and optionally adjust scopes or duration.
   */
  approveInApp(
    requestId: string,
    patientId: string,
    adjustments?: { scopes?: string[]; customHours?: number }
  ): StoredConsentGrant {
    const request = this.pendingRequests.get(requestId);
    if (!request) {
      throw new Error('Access request not found');
    }
    if (request.patientId !== patientId) {
      throw new Error('Unauthorized: Patient does not own this access request');
    }
    if (request.status !== 'PENDING') {
      throw new Error(`Request cannot be approved; current status is ${request.status}`);
    }

    const hours = adjustments?.customHours || request.durationHours;
    const scopes = adjustments?.scopes || request.requestedScopes;

    const grantId = crypto.randomUUID();
    const now = new Date();
    const validUntil = new Date(now.getTime() + hours * 3600 * 1000);

    const grant: StoredConsentGrant = {
      id: grantId,
      patientId,
      targetClinicianId: request.requestingClinicianId,
      requestingClinicianName: request.requestingClinicianName,
      targetFacilityId: request.requestingFacilityId,
      requestingFacilityName: request.requestingFacilityName,
      scopes,
      validUntil,
      isRevoked: false,
      clinicalReason: request.clinicalReason,
      createdAt: now.toISOString(),
    };

    request.status = 'APPROVED';
    this.activeGrants.set(grantId, grant);

    const patientList = this.patientGrants.get(patientId) || [];
    patientList.push(grantId);
    this.patientGrants.set(patientId, patientList);

    this.auditManager.appendEntry({
      actorId: patientId,
      subjectId: patientId,
      action: 'CONSENT_GRANTED_IN_APP',
      accessType: 'NORMAL_CONSENT',
      facilityId: request.requestingFacilityId,
      ipAddress: '127.0.0.1',
      userAgent: 'PatientApp/1.0',
      reason: `Patient approved access for ${request.requestingClinicianName} (${request.requestingFacilityName}) for ${hours}h`,
    });

    return grant;
  }

  /**
   * 3B. One-Time Passcode (OTP) Approval.
   * Clinician inputs the 6-digit OTP provided by the patient via SMS/Email.
   */
  approveViaOtp(requestId: string, rawOtp: string, expectedClinicianId?: string): StoredConsentGrant {
    const request = this.pendingRequests.get(requestId);
    if (!request) throw new Error('Access request not found');
    if (expectedClinicianId && request.requestingClinicianId !== expectedClinicianId) {
      throw new Error('Unauthorized: This access request belongs to another clinician');
    }
    if (request.status !== 'PENDING') throw new Error(`Request is already ${request.status}`);

    const now = Date.now();
    if (now > request.otpExpiresAt) {
      request.status = 'EXPIRED';
      throw new Error('OTP has expired. Clinician must initiate a new access request.');
    }

    if (request.otpAttemptsRemaining <= 0) {
      request.status = 'REJECTED';
      throw new Error('Too many failed OTP attempts. Request locked.');
    }

    const testHash = crypto.createHash('sha256').update(rawOtp.trim()).digest('hex');
    const isMatch = crypto.timingSafeEqual(Buffer.from(testHash), Buffer.from(request.hashedOtp));

    if (!isMatch) {
      request.otpAttemptsRemaining--;
      throw new Error(`Invalid OTP. ${request.otpAttemptsRemaining} attempts remaining.`);
    }

    // OTP Validated: Issue Consent Grant
    const grantId = crypto.randomUUID();
    const nowDate = new Date();
    const validUntil = new Date(nowDate.getTime() + request.durationHours * 3600 * 1000);

    const grant: StoredConsentGrant = {
      id: grantId,
      patientId: request.patientId,
      targetClinicianId: request.requestingClinicianId,
      requestingClinicianName: request.requestingClinicianName,
      targetFacilityId: request.requestingFacilityId,
      requestingFacilityName: request.requestingFacilityName,
      scopes: request.requestedScopes,
      validUntil,
      isRevoked: false,
      clinicalReason: request.clinicalReason,
      createdAt: nowDate.toISOString(),
    };

    request.status = 'APPROVED';
    this.activeGrants.set(grantId, grant);

    const list = this.patientGrants.get(request.patientId) || [];
    list.push(grantId);
    this.patientGrants.set(request.patientId, list);

    this.auditManager.appendEntry({
      actorId: request.requestingClinicianId,
      subjectId: request.patientId,
      action: 'CONSENT_GRANTED_VIA_OTP',
      accessType: 'NORMAL_CONSENT',
      facilityId: request.requestingFacilityId,
      ipAddress: '127.0.0.1',
      userAgent: 'ClinicalClient/1.0',
      reason: `Consent verified via one-time SMS/Email passcode for ${request.requestingClinicianName}`,
    });

    return grant;
  }

  /**
   * 4. Pre-Shared Link / QR Generator.
   * Patient creates a time-limited authorization token for a specific facility before arrival.
   */
  generatePreSharedGrant(
    patientId: string,
    targetFacilityId: string,
    facilityName: string,
    scopes = ['all'],
    validHours = 48
  ): { grant: StoredConsentGrant; preSharedToken: string } {
    const grantId = crypto.randomUUID();
    const now = new Date();
    const validUntil = new Date(now.getTime() + validHours * 3600 * 1000);
    const nonce = crypto.randomBytes(16).toString('hex');

    const grant: StoredConsentGrant = {
      id: grantId,
      patientId,
      targetFacilityId,
      requestingClinicianName: 'Attending Clinician (Pre-Shared)',
      requestingFacilityName: facilityName,
      scopes,
      validUntil,
      isRevoked: false,
      clinicalReason: 'Pre-shared consultation token created by patient',
      createdAt: now.toISOString(),
    };

    this.activeGrants.set(grantId, grant);
    const list = this.patientGrants.get(patientId) || [];
    list.push(grantId);
    this.patientGrants.set(patientId, list);

    // Cryptographic pre-shared URL token
    const tokenPayload = {
      grantId,
      patientId,
      targetFacilityId,
      nonce,
      exp: validUntil.getTime(),
    };
    const preSharedToken = Buffer.from(JSON.stringify(tokenPayload)).toString('base64url');

    this.auditManager.appendEntry({
      actorId: patientId,
      subjectId: patientId,
      action: 'CONSENT_PRE_SHARED_GENERATED',
      accessType: 'PRE_SHARED_LINK',
      facilityId: targetFacilityId,
      ipAddress: '127.0.0.1',
      userAgent: 'PatientApp/1.0',
      reason: `Patient pre-shared medical record with ${facilityName} for ${validHours}h`,
    });

    return { grant, preSharedToken };
  }

  /**
   * 5. Immediate Consent Revocation.
   * Patient immediately revokes an active grant.
   */
  revokeConsent(patientId: string, grantId: string, reason = 'Patient revoked consent'): StoredConsentGrant {
    const grant = this.activeGrants.get(grantId);
    if (!grant) {
      throw new Error('Consent grant not found');
    }
    if (grant.patientId !== patientId) {
      throw new Error('Unauthorized: You can only revoke consent for your own records');
    }
    if (grant.isRevoked) {
      throw new Error('Consent is already revoked');
    }

    const now = new Date().toISOString();
    grant.isRevoked = true;
    grant.revokedAt = now;
    grant.revocationReason = reason;

    this.auditManager.appendEntry({
      actorId: patientId,
      subjectId: patientId,
      action: 'CONSENT_REVOKED',
      accessType: 'NORMAL_CONSENT',
      facilityId: grant.targetFacilityId,
      ipAddress: '127.0.0.1',
      userAgent: 'PatientApp/1.0',
      reason: `Consent revoked: ${reason}`,
    });

    return grant;
  }

  /**
   * 6. Resolves active consent for policy engine.
   */
  resolveActiveConsent(patientId: string, clinicianId: string, facilityId: string): ConsentContext | null {
    const grantIds = this.patientGrants.get(patientId) || [];
    const now = new Date();

    for (const id of grantIds) {
      const grant = this.activeGrants.get(id);
      if (!grant) continue;
      if (grant.isRevoked) continue;
      if (now > new Date(grant.validUntil)) continue;

      // Match facility or clinician
      if (grant.targetFacilityId && grant.targetFacilityId === facilityId) {
        return grant;
      }
      if (grant.targetClinicianId && grant.targetClinicianId === clinicianId) {
        return grant;
      }
    }

    return null;
  }

  /**
   * 7. Retrieves all consent grants for a patient (active, expired, and revoked).
   */
  getPatientConsents(patientId: string): StoredConsentGrant[] {
    const ids = this.patientGrants.get(patientId) || [];
    return ids
      .map((id) => this.activeGrants.get(id)!)
      .filter(Boolean)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /**
   * 8. Lists a patient's pending access requests (OTP hash is never exposed).
   */
  getPendingRequests(patientId: string): Array<Omit<PendingAccessRequest, 'hashedOtp'>> {
    const now = Date.now();
    const result: Array<Omit<PendingAccessRequest, 'hashedOtp'>> = [];
    for (const req of this.pendingRequests.values()) {
      if (req.patientId !== patientId) continue;
      if (req.status === 'PENDING' && now > req.otpExpiresAt) req.status = 'EXPIRED';
      const { hashedOtp: _omit, ...safe } = req;
      result.push(safe);
    }
    return result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /**
   * 9. Rejects a pending access request on behalf of the patient.
   */
  rejectRequest(requestId: string, patientId: string): void {
    const request = this.pendingRequests.get(requestId);
    if (!request) throw new Error('Access request not found');
    if (request.patientId !== patientId) throw new Error('Unauthorized: Patient does not own this access request');
    if (request.status !== 'PENDING') throw new Error(`Request is already ${request.status}`);
    request.status = 'REJECTED';
    this.auditManager.appendEntry({
      actorId: patientId,
      subjectId: patientId,
      action: 'CONSENT_REQUEST_REJECTED',
      accessType: 'NORMAL_CONSENT',
      facilityId: request.requestingFacilityId,
      ipAddress: '127.0.0.1',
      userAgent: 'PatientApp/1.0',
      reason: `Patient rejected access request from ${request.requestingClinicianName} (${request.requestingFacilityName})`,
    });
  }
}
