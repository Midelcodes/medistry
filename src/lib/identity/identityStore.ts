/**
 * National identifiers (Phase 16): stored encrypted (AES-256-GCM, field key) for display and re-indexing, plus a
 * "blind index" for exact-match lookup without decrypting: HMAC-SHA256 under IDENTITY_INDEX_KEY, a key separate from
 * the field-encryption key, over "<country>|<idType>|<normalised number>". A raw identifier is never stored, logged
 * or put in an audit entry; responses show it masked.
 *
 * TODO: rotating IDENTITY_INDEX_KEY needs a re-index (decrypt each identifier, recompute the index); not scripted yet.
 */
import crypto from 'node:crypto';
import { encryptField } from '../patient/profile.ts';
import { appSecret } from '../security/config.ts';
import { normaliseIdNumber, type IdentityStatus } from './IdentityVerifier.ts';

export interface PatientIdentifier {
  id: string;
  patientId: string;
  country: string;
  idType: string;
  blindIndex: string;
  encryptedValue: string;
  last2: string;                  // for a masked display (e.g. "NIN •••••••••01")
  status: IdentityStatus;         // result of the last verification; 'unavailable' = not checked yet
  matchScore: number;
  verifier: string;
  verifiedAt?: string;
  createdAt: string;
}

export interface IdentifierRepo { savePatientIdentifier(i: PatientIdentifier): void }

/** Exact-match lookup key. Separate key from field encryption, so a leaked database alone cannot be indexed. */
export function identityBlindIndex(country: string, idType: string, idNumber: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = Buffer.from(env === process.env ? appSecret('IDENTITY_INDEX_KEY', { hex: true }) : String(env.IDENTITY_INDEX_KEY), 'hex');
  return crypto.createHmac('sha256', key).update(`${country.toUpperCase()}|${idType.toUpperCase()}|${normaliseIdNumber(idNumber)}`).digest('hex');
}

export class IdentityStore {
  private byIndex = new Map<string, PatientIdentifier>();
  persistence?: IdentifierRepo;

  hydrate(rows: PatientIdentifier[]): void {
    for (const i of rows) this.byIndex.set(i.blindIndex, i);
  }

  /** The patient holding this identifier, by blind index (no decryption). */
  findPatient(country: string, idType: string, idNumber: string): string | undefined {
    return this.byIndex.get(identityBlindIndex(country, idType, idNumber))?.patientId;
  }

  forPatient(patientId: string): PatientIdentifier[] {
    return [...this.byIndex.values()].filter((i) => i.patientId === patientId);
  }

  /** Masked view for responses: never the full number. */
  static masked(i: PatientIdentifier) {
    return { country: i.country, idType: i.idType, display: `${i.idType} ${'•'.repeat(6)}${i.last2}`, status: i.status, verifier: i.verifier };
  }

  add(patientId: string, id: { country: string; idType: string; idNumber: string }, verification: { status: IdentityStatus; matchScore: number; verifier: string }): PatientIdentifier {
    const blindIndex = identityBlindIndex(id.country, id.idType, id.idNumber);
    const existing = this.byIndex.get(blindIndex);
    if (existing && existing.patientId !== patientId) throw new Error('This identifier already belongs to another patient');
    const now = new Date().toISOString();
    const value = normaliseIdNumber(id.idNumber);
    const row: PatientIdentifier = {
      id: existing?.id || crypto.randomUUID(), patientId, country: id.country.toUpperCase(), idType: id.idType.toUpperCase(), blindIndex,
      encryptedValue: encryptField(value), last2: value.slice(-2), status: verification.status, matchScore: verification.matchScore,
      verifier: verification.verifier, ...(verification.status === 'verified' ? { verifiedAt: now } : {}), createdAt: existing?.createdAt || now,
    };
    this.byIndex.set(blindIndex, row);
    this.persistence?.savePatientIdentifier(row);
    return row;
  }
}
