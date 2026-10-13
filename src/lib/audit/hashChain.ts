/**
 * MEDISTRY Tamper-Evident Audit Log (Hash-Chained Architecture)
 * Guarantees mathematical immutability for clinical read/write events.
 */

import crypto from 'node:crypto';

export interface AuditRecordPayload {
  sequenceNumber: number;
  timestamp: string; // ISO 8601
  actorId: string;
  subjectId?: string; // Patient ID
  action: string;
  accessType: 'NORMAL_CONSENT' | 'EMERGENCY_BREAK_GLASS' | 'PRE_SHARED_LINK' | 'SYSTEM_ADMIN';
  resourceType?: string;
  resourceId?: string;
  facilityId?: string;
  countryCode?: string;
  ipAddress: string;
  userAgent: string;
  reason?: string;
}

export interface ChainedAuditEntry extends AuditRecordPayload {
  id: string;
  previousHash: string;
  currentHash: string;
}

export const GENESIS_HASH = '0'.repeat(64);

/**
 * Computes the canonical SHA-256 hash for an audit record linked to its predecessor.
 */
export function computeAuditEntryHash(
  payload: AuditRecordPayload,
  previousHash: string
): string {
  const canonicalString = [
    payload.sequenceNumber,
    payload.timestamp,
    payload.actorId,
    payload.subjectId || '',
    payload.action,
    payload.accessType,
    payload.resourceType || '',
    payload.resourceId || '',
    payload.facilityId || '',
    payload.countryCode || 'NG',
    payload.ipAddress,
    payload.reason || '',
    previousHash,
  ].join('|');

  return crypto.createHash('sha256').update(canonicalString, 'utf8').digest('hex');
}

/**
 * Audit log chain manager.
 */
export class AuditChainManager {
  private chain: ChainedAuditEntry[] = [];

  constructor(initialEntries: ChainedAuditEntry[] = []) {
    this.chain = [...initialEntries];
  }

  getLatestEntry(): ChainedAuditEntry | undefined {
    return this.chain[this.chain.length - 1];
  }

  getEntries(): ChainedAuditEntry[] {
    return [...this.chain];
  }

  /**
   * Appends an immutable audit event to the hash chain.
   */
  appendEntry(
    rawPayload: Omit<AuditRecordPayload, 'sequenceNumber' | 'timestamp'> & {
      timestamp?: string;
    }
  ): ChainedAuditEntry {
    const previousEntry = this.getLatestEntry();
    const previousHash = previousEntry ? previousEntry.currentHash : GENESIS_HASH;
    const sequenceNumber = previousEntry ? previousEntry.sequenceNumber + 1 : 1;
    const timestamp = rawPayload.timestamp || new Date().toISOString();

    const fullPayload: AuditRecordPayload = {
      ...rawPayload,
      sequenceNumber,
      timestamp,
    };

    const currentHash = computeAuditEntryHash(fullPayload, previousHash);

    const entry: ChainedAuditEntry = {
      ...fullPayload,
      id: crypto.randomUUID(),
      previousHash,
      currentHash,
    };

    this.chain.push(entry);
    return entry;
  }

  /**
   * Verifies the entire cryptographic integrity of the audit log chain.
   * Detects record modification, insertion, deletion, or reordering.
   */
  verifyChain(): { valid: boolean; error?: string; corruptedIndex?: number } {
    if (this.chain.length === 0) {
      return { valid: true };
    }

    for (let i = 0; i < this.chain.length; i++) {
      const current = this.chain[i];
      const expectedPreviousHash = i === 0 ? GENESIS_HASH : this.chain[i - 1].currentHash;

      // 1. Verify previous hash pointer
      if (current.previousHash !== expectedPreviousHash) {
        return {
          valid: false,
          error: `Chain broken at sequence ${current.sequenceNumber}: previousHash does not match predecessor hash`,
          corruptedIndex: i,
        };
      }

      // 2. Recompute current hash to detect row alteration
      const recomputedHash = computeAuditEntryHash(current, current.previousHash);
      if (current.currentHash !== recomputedHash) {
        return {
          valid: false,
          error: `Tamper detected at sequence ${current.sequenceNumber}: payload does not match currentHash`,
          corruptedIndex: i,
        };
      }

      // 3. Verify sequence number linearity
      if (current.sequenceNumber !== i + 1) {
        return {
          valid: false,
          error: `Non-linear sequence number at index ${i}: expected ${i + 1}, got ${current.sequenceNumber}`,
          corruptedIndex: i,
        };
      }
    }

    return { valid: true };
  }

  /**
   * Retrieves all entries in the audit chain.
   */
  getChain(): ChainedAuditEntry[] {
    return [...this.chain];
  }

  /**
   * Retrieves records for a specific patient for the "Who accessed my record" page.
   */
  getPatientAccessHistory(patientId: string): ChainedAuditEntry[] {
    return this.chain
      .filter((entry) => entry.subjectId === patientId)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }
}

