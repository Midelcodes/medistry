/**
 * MEDISTRY Patient Emergency Code Lifecycle Manager
 * Handles code issuance, revocation, and reissuance without clinical data loss.
 */

import { generatePatientUniqueCode, hashEmergencyCode, type GeneratedCodeResult } from './crockford.ts';
import { AuditChainManager } from '../audit/hashChain.ts';

export interface StoredEmergencyCode {
  id: string;
  patientId: string;
  codeHash: string;
  displayMaskedCode: string; // e.g. K7QM-****-****-8W
  formattedCode?: string;    // Only available to patient at generation
  isActive: boolean;
  revokedAt?: string;
  revocationReason?: string;
  reissuedFromId?: string;
  createdAt: string;
}

export class EmergencyCodeLifecycleManager {
  private codesStore = new Map<string, StoredEmergencyCode>(); // Key: codeHash
  private patientActiveCode = new Map<string, string>();       // Key: patientId -> codeHash
  private auditManager: AuditChainManager;

  constructor(auditManager: AuditChainManager) {
    this.auditManager = auditManager;
  }

  /**
   * Masks a human-readable Crockford code for storage/display (reveals first 4 and last 2 characters).
   */
  private maskCode(formattedCode: string): string {
    const parts = formattedCode.split('-');
    if (parts.length === 4) {
      return `${parts[0]}-****-****-${parts[3]}`;
    }
    return '****-****-****-****';
  }

  /**
   * Issues an initial 128-bit emergency code for a newly registered patient.
   */
  issueInitialCode(patientId: string, domain = 'medistry.health'): GeneratedCodeResult & { record: StoredEmergencyCode } {
    const generated = generatePatientUniqueCode(domain);
    const now = new Date().toISOString();

    const record: StoredEmergencyCode = {
      id: crypto.randomUUID(),
      patientId,
      codeHash: generated.codeHash,
      displayMaskedCode: this.maskCode(generated.formattedCode),
      formattedCode: generated.formattedCode,
      isActive: true,
      createdAt: now,
    };

    this.codesStore.set(generated.codeHash, record);
    this.patientActiveCode.set(patientId, generated.codeHash);

    this.auditManager.appendEntry({
      actorId: patientId,
      subjectId: patientId,
      action: 'EMERGENCY_CODE_INITIAL_ISSUANCE',
      accessType: 'NORMAL_CONSENT',
      reason: 'Patient onboarding',
      ipAddress: '127.0.0.1',
      userAgent: 'System/1.0',
    });

    return { ...generated, record };
  }

  /**
   * Revokes an existing code and reissues a new one (e.g. Lost card / stolen device).
   * Patient's clinical records remain completely intact.
   */
  revokeAndReissue(
    patientId: string,
    reason: string,
    actorId = patientId,
    domain = 'medistry.health'
  ): GeneratedCodeResult & { oldRecord: StoredEmergencyCode; newRecord: StoredEmergencyCode } {
    const activeHash = this.patientActiveCode.get(patientId);
    if (!activeHash) {
      throw new Error(`No active emergency code found for patient ${patientId}`);
    }

    const oldRecord = this.codesStore.get(activeHash);
    if (!oldRecord || !oldRecord.isActive) {
      throw new Error('Active emergency code record is invalid or already revoked');
    }

    const now = new Date().toISOString();

    // 1. Immediately revoke the old code
    oldRecord.isActive = false;
    oldRecord.revokedAt = now;
    oldRecord.revocationReason = reason;

    // 2. Generate a new 128-bit random code
    const generated = generatePatientUniqueCode(domain);

    const newRecord: StoredEmergencyCode = {
      id: crypto.randomUUID(),
      patientId,
      codeHash: generated.codeHash,
      displayMaskedCode: this.maskCode(generated.formattedCode),
      formattedCode: generated.formattedCode,
      isActive: true,
      reissuedFromId: oldRecord.id,
      createdAt: now,
    };

    // 3. Store new record and update patient mapping
    this.codesStore.set(generated.codeHash, newRecord);
    this.patientActiveCode.set(patientId, generated.codeHash);

    // 4. Log immutable audit entry
    this.auditManager.appendEntry({
      actorId,
      subjectId: patientId,
      action: 'EMERGENCY_CODE_REVOKED_AND_REISSUED',
      accessType: 'NORMAL_CONSENT',
      reason: `Lost card/reissue: ${reason}`,
      ipAddress: '127.0.0.1',
      userAgent: 'System/1.0',
    });

    return {
      ...generated,
      oldRecord,
      newRecord,
    };
  }

  /**
   * Resolves a code hash to an active patient emergency record.
   * Returns null if code is invalid or has been revoked.
   */
  resolveActiveCode(rawCode: string): { valid: boolean; patientId?: string; isRevoked?: boolean } {
    const codeHash = hashEmergencyCode(rawCode);
    const record = this.codesStore.get(codeHash);

    if (!record) {
      return { valid: false };
    }

    if (!record.isActive) {
      return { valid: false, isRevoked: true, patientId: record.patientId };
    }

    return { valid: true, patientId: record.patientId };
  }

  /**
   * Gets the active code record for a patient.
   */
  getActiveCodeForPatient(patientId: string): StoredEmergencyCode | undefined {
    const hash = this.patientActiveCode.get(patientId);
    if (!hash) return undefined;
    return this.codesStore.get(hash);
  }
}
