/**
 * National identity verification (Phase 16). One adapter per country and ID type, behind one interface.
 *
 *   NG  NimcVerifier       stub. Real NIN verification needs access through NIMC or a licensed verification
 *                          partner. TODO: integrate through that official channel only; never call an unofficial API.
 *   KE  KenyaIdVerifier    stub for national ID / SHA number. TODO: confirm the official verification channel.
 *   demo FakeIdentityVerifier  synthetic records only (demo mode and tests).
 *
 * 'unavailable' means "could not check now", never "rejected": registration continues with the identifier marked
 * unverified, and nothing in emergency care waits for, or depends on, a verification result.
 */
import { nameSimilarity, nameTokens } from './names.ts';

export type IdentityStatus = 'verified' | 'mismatch' | 'not_found' | 'unavailable';

export interface IdentityVerificationRequest {
  country: string;   // ISO 3166-1 alpha-2
  idType: string;    // e.g. NIN, NATIONAL_ID, SHA
  idNumber: string;
  name: string;      // full name as given
  dob: string;       // YYYY-MM-DD
}

export interface IdentityVerificationResult {
  status: IdentityStatus;
  /** 0..1: how well name and date of birth agree with the authority's record (0 when not checked). */
  matchScore: number;
  verifier: string;
}

export interface IdentityVerifier {
  readonly name: string;
  verify(req: IdentityVerificationRequest): Promise<IdentityVerificationResult>;
}

/** ID types this build knows, per country. Format checks are deliberately loose where the format is not confirmed. */
export const ID_TYPES: Record<string, Record<string, RegExp>> = {
  NG: { NIN: /^\d{11}$/ },                                  // the National Identification Number has 11 digits
  KE: { NATIONAL_ID: /^[0-9A-Z]{5,12}$/, SHA: /^[0-9A-Z-]{5,20}$/ }, // TODO: confirm the official formats
};

export function normaliseIdNumber(idNumber: string): string {
  return String(idNumber || '').toUpperCase().replace(/[\s.-]/g, '');
}

export class NimcVerifier implements IdentityVerifier {
  readonly name = 'nimc-not-integrated';
  async verify(): Promise<IdentityVerificationResult> {
    // TODO: NIN verification through NIMC or a licensed verification partner (contract, credentials, consent
    // wording and data handling agreed first). Until then every check is reported as unavailable.
    return { status: 'unavailable', matchScore: 0, verifier: this.name };
  }
}

/** Countries without a verification channel in this build: always unavailable (never blocks registration). */
export class UnsupportedCountryVerifier implements IdentityVerifier {
  readonly name = 'no-verification-channel';
  async verify(): Promise<IdentityVerificationResult> {
    return { status: 'unavailable', matchScore: 0, verifier: this.name };
  }
}

export class KenyaIdVerifier implements IdentityVerifier {
  readonly name = 'kenya-id-not-integrated';
  async verify(): Promise<IdentityVerificationResult> {
    // TODO: confirm the official channel for national ID and SHA number verification, then integrate it.
    return { status: 'unavailable', matchScore: 0, verifier: this.name };
  }
}

/** Synthetic identity register for demo and tests. Never contains real people or real ID numbers. */
export const SYNTHETIC_IDENTITY_RECORDS: Array<{ country: string; idType: string; idNumber: string; name: string; dob: string }> = [
  { country: 'NG', idType: 'NIN', idNumber: '90000000001', name: 'Synthetic Adaeze Nwosu', dob: '1990-03-14' },
  { country: 'NG', idType: 'NIN', idNumber: '90000000002', name: 'Synthetic Babatunde Olatunji', dob: '1985-11-02' },
  { country: 'NG', idType: 'NIN', idNumber: '90000000003', name: 'Synthetic Hauwa Ɗanjuma', dob: '2001-07-21' },
  { country: 'KE', idType: 'NATIONAL_ID', idNumber: '90000001', name: 'Synthetic Achieng Odhiambo', dob: '1993-05-09' },
];

export class FakeIdentityVerifier implements IdentityVerifier {
  readonly name = 'synthetic-demo-register';
  private records: typeof SYNTHETIC_IDENTITY_RECORDS;
  constructor(records = SYNTHETIC_IDENTITY_RECORDS) {
    this.records = records;
  }
  async verify(req: IdentityVerificationRequest): Promise<IdentityVerificationResult> {
    const id = normaliseIdNumber(req.idNumber);
    const rec = this.records.find((r) => r.country === req.country && r.idType === req.idType && normaliseIdNumber(r.idNumber) === id);
    if (!rec) return { status: 'not_found', matchScore: 0, verifier: this.name };
    // "Synthetic" is a marker in these records, not part of the person's name.
    const name = nameSimilarity(nameTokens(rec.name.replace(/^Synthetic\s+/, '')), nameTokens(req.name.replace(/^Synthetic\s+/, '')));
    const score = Math.round((0.6 * name + 0.4 * (rec.dob === req.dob ? 1 : 0)) * 100) / 100;
    return { status: name >= 0.85 && rec.dob === req.dob ? 'verified' : 'mismatch', matchScore: score, verifier: this.name };
  }
}

/** Verifier per country: the synthetic register in demo mode, the (stub) official channels with real data. */
export function createIdentityVerifier(env: NodeJS.ProcessEnv = process.env): (country: string) => IdentityVerifier {
  const demo = env.DEMO_MODE !== '0';
  const fake = new FakeIdentityVerifier();
  const ng = new NimcVerifier();
  const ke = new KenyaIdVerifier();
  const none = new UnsupportedCountryVerifier();
  return (country) => (demo ? fake : country === 'NG' ? ng : country === 'KE' ? ke : none);
}
