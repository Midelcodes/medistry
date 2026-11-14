/**
 * MEDISTRY Offline Card Registry (in memory; mirrors the OfflineCard model in prisma/schema.prisma)
 * Every issued card gets a row with its version, signing key id and a SHA-256 hash of the token.
 * The token itself is not stored. Issuing a new card supersedes the previous one.
 */
import crypto from 'node:crypto';
import type { PatientEntity } from '../patient/profile.ts';
import type { AuditChainManager } from '../audit/hashChain.ts';
import {
  buildCardPayload,
  signCardWithSizeGuard,
  cardValidityDays,
  type CardDiagnosis,
  type CompactCardPayload,
} from './cardPayload.ts';

export interface OfflineCardRecord {
  id: string;
  patientId: string;
  version: number;
  kid: string;
  payloadHash: string; // SHA-256 hex of the signed token
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
  revocationReason?: string;
  supersededById?: string;
}

export interface IssuedOfflineCard {
  card: OfflineCardRecord;
  token: string;
  payload: CompactCardPayload;
  warnings: string[];
}

export class OfflineCardStore {
  private cards = new Map<string, OfflineCardRecord>();
  private byPatient = new Map<string, string[]>(); // patientId -> card ids, oldest first
  private auditManager?: AuditChainManager;

  constructor(auditManager?: AuditChainManager) {
    this.auditManager = auditManager;
  }

  /**
   * Issues a new card: version = patient.cardVersion + 1, creates the row, marks the previous card
   * superseded and increments patient.cardVersion.
   */
  issue(
    patient: PatientEntity,
    opts: { recentDiagnosis?: CardDiagnosis | null; validityDays?: number; nowSeconds?: number; maxTokenLength?: number } = {}
  ): IssuedOfflineCard {
    const version = (patient.cardVersion || 0) + 1;
    const draft = buildCardPayload(patient, {
      cardVersion: version,
      recentDiagnosis: opts.recentDiagnosis,
      validityDays: opts.validityDays ?? cardValidityDays(),
      nowSeconds: opts.nowSeconds,
    });
    const { token, payload, warnings } = signCardWithSizeGuard(draft, { maxLength: opts.maxTokenLength });
    const kid = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')).kid;

    const card: OfflineCardRecord = {
      id: crypto.randomUUID(),
      patientId: patient.id,
      version,
      kid,
      payloadHash: crypto.createHash('sha256').update(token).digest('hex'),
      issuedAt: new Date(payload.iat * 1000).toISOString(),
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    };

    const previous = this.getCurrent(patient.id);
    if (previous) previous.supersededById = card.id;

    this.cards.set(card.id, card);
    this.byPatient.set(patient.id, [...(this.byPatient.get(patient.id) || []), card.id]);
    patient.cardVersion = version;
    patient.updatedAt = new Date().toISOString();

    // No card content in the audit trail, only the fact of issuance.
    this.auditManager?.appendEntry({
      actorId: patient.id,
      subjectId: patient.id,
      action: 'OFFLINE_CARD_ISSUED',
      accessType: 'NORMAL_CONSENT',
      resourceType: 'OfflineCard',
      resourceId: card.id,
      ipAddress: '127.0.0.1',
      userAgent: 'PatientPortal/1.0',
      reason: `Offline card v${version} issued${previous ? `, superseding v${previous.version}` : ''}`,
    });

    return { card: { ...card }, token, payload, warnings };
  }

  /** The newest card that has not been superseded or revoked. */
  getCurrent(patientId: string): OfflineCardRecord | undefined {
    const ids = this.byPatient.get(patientId) || [];
    for (let i = ids.length - 1; i >= 0; i--) {
      const c = this.cards.get(ids[i])!;
      if (!c.supersededById && !c.revokedAt) return c;
    }
    return undefined;
  }

  list(patientId: string): OfflineCardRecord[] {
    return (this.byPatient.get(patientId) || []).map((id) => ({ ...this.cards.get(id)! }));
  }

  get(cardId: string): OfflineCardRecord | undefined {
    const c = this.cards.get(cardId);
    return c ? { ...c } : undefined;
  }
}
