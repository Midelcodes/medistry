/**
 * MEDISTRY Offline Card Registry (in memory; mirrors the OfflineCard model in prisma/schema.prisma)
 * Every issued card gets a row with its version, signing key id and a SHA-256 hash of the token.
 * Rows never hold the token. Only the CURRENT card's token is kept in process memory so the patient
 * can view and print it again without reissuing; it is dropped when the card is superseded.
 * Issuing a new card supersedes the previous one.
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
  private currentTokens = new Map<string, { cardId: string; token: string }>(); // patientId -> current card token
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
    this.currentTokens.set(patient.id, { cardId: card.id, token });
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

  /**
   * Returns the patient's current card if it is still valid (not superseded, revoked or expired),
   * otherwise issues a new one. `reused` tells the caller which happened.
   */
  getOrIssue(
    patient: PatientEntity,
    opts: Parameters<OfflineCardStore['issue']>[1] = {}
  ): IssuedOfflineCard & { reused: boolean } {
    const current = this.getCurrent(patient.id);
    const cached = this.currentTokens.get(patient.id);
    const now = opts.nowSeconds !== undefined ? opts.nowSeconds * 1000 : Date.now();
    if (current && cached?.cardId === current.id && new Date(current.expiresAt).getTime() > now) {
      const payload = JSON.parse(Buffer.from(cached.token.split('.')[1], 'base64url').toString('utf8')) as CompactCardPayload;
      return { card: { ...current }, token: cached.token, payload, warnings: [], reused: true };
    }
    return { ...this.issue(patient, opts), reused: false };
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
