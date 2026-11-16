/**
 * Master patient index (Phase 16): one person, one record.
 *
 *   - An exact national-identifier match (blind index) is the same patient (identityStore.ts).
 *   - Otherwise a probabilistic score over normalised name, date of birth, gender and phone gives candidate
 *     duplicates. Nothing is ever merged automatically: pairs at or above MPI_REVIEW_THRESHOLD go to a review queue
 *     for a records officer of the facility involved, or a platform admin.
 *   - Merge links the duplicate under a surviving patient id: both records and histories are kept as they are,
 *     the survivor's views include the merged record's history, and the merged id resolves to the survivor.
 *     Unmerge removes the link and restores the original state exactly. Both are audited.
 */
import crypto from 'node:crypto';
import { decryptPatientDemographics, type PatientEntity } from '../patient/profile.ts';
import type { AuditChainManager } from '../audit/hashChain.ts';
import type { AccountStore, UserAccount } from '../auth/accounts.ts';
import { AuthError, type RequestInfo } from '../auth/patientAuth.ts';
import { evaluatePolicy } from '../policy/enforcer.ts';
import { nameSimilarity, nameTokens } from './names.ts';

export const CANDIDATE_MIN_SCORE = 0.6;
// Operational setting, tune per deployment with real review outcomes.
export const REVIEW_THRESHOLD = Math.min(0.99, Math.max(0.6, Number(process.env.MPI_REVIEW_THRESHOLD) || 0.8));
const WEIGHTS = { name: 0.45, dob: 0.3, gender: 0.1, phone: 0.15 };

export interface MatchDemographics { name: string; dob: string; gender?: string; phone?: string }
export interface MatchBreakdown { name: number; dob: number; gender: number | null; phone: number | null }
export interface CandidateMatch { patientId: string; score: number; breakdown: MatchBreakdown }

export interface DuplicateReview {
  id: string;
  patientId: string;          // the newer record
  candidatePatientId: string; // the existing record it may duplicate
  score: number;
  breakdown: MatchBreakdown;
  facilityId: string;         // where the pair was found (registration or import facility)
  source: 'registration' | 'import';
  status: 'OPEN' | 'MERGED' | 'NOT_DUPLICATE';
  createdAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
}

export interface PatientMerge {
  id: string;
  survivorId: string;
  mergedId: string;
  reviewId?: string;
  mergedBy: string;
  mergedAt: string;
  status: 'ACTIVE' | 'UNDONE';
  unmergedBy?: string;
  unmergedAt?: string;
}

export interface MpiRepo {
  saveDuplicateReview(r: DuplicateReview): void;
  savePatientMerge(m: PatientMerge): void;
  savePatient(p: PatientEntity): void;
}

/** Date of birth agreement: exact, day and month transposed (a common entry error), or same year and month. */
function dobScore(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const [ya, ma, da] = a.split('-');
  const [yb, mb, db] = b.split('-');
  if (ya === yb && ma === db && da === mb) return 0.7;
  if (ya === yb && ma === mb) return 0.3;
  return 0;
}

/** Weighted score over the fields both sides have (a missing phone or gender neither helps nor hurts). */
export function scoreMatch(a: MatchDemographics, b: MatchDemographics): { score: number; breakdown: MatchBreakdown } {
  const breakdown: MatchBreakdown = {
    name: nameSimilarity(nameTokens(a.name), nameTokens(b.name)),
    dob: dobScore(a.dob, b.dob),
    gender: a.gender && b.gender ? (a.gender.toLowerCase() === b.gender.toLowerCase() ? 1 : 0) : null,
    phone: a.phone && b.phone ? (a.phone === b.phone ? 1 : 0) : null,
  };
  let sum = WEIGHTS.name * breakdown.name + WEIGHTS.dob * breakdown.dob;
  let weight = WEIGHTS.name + WEIGHTS.dob;
  if (breakdown.gender !== null) { sum += WEIGHTS.gender * breakdown.gender; weight += WEIGHTS.gender; }
  if (breakdown.phone !== null) { sum += WEIGHTS.phone * breakdown.phone; weight += WEIGHTS.phone; }
  return { score: Math.round((sum / weight) * 1000) / 1000, breakdown };
}

export class MasterPatientIndex {
  private reviews = new Map<string, DuplicateReview>();
  private merges = new Map<string, PatientMerge>();
  private deps: { patientsById: Map<string, PatientEntity>; accounts: AccountStore; auditManager: AuditChainManager };
  persistence?: MpiRepo;

  constructor(deps: MasterPatientIndex['deps']) {
    this.deps = deps;
  }

  hydrate(reviews: DuplicateReview[], merges: PatientMerge[]): void {
    for (const r of reviews) this.reviews.set(r.id, r);
    for (const m of merges) this.merges.set(m.id, m);
  }

  /** Name, date of birth, gender and sign-in phone of a stored patient (decrypted in memory only). */
  demographicsOf(p: PatientEntity): MatchDemographics {
    const d = decryptPatientDemographics(p);
    const account = this.deps.accounts.byPatient(p.id);
    return { name: `${d.firstName} ${d.lastName}`, dob: d.dateOfBirth, gender: d.gender, phone: account ? this.deps.accounts.phoneOf(account) : undefined };
  }

  /** Candidate duplicates (score >= CANDIDATE_MIN_SCORE), best first. Merged-away records are not candidates. */
  findCandidates(input: MatchDemographics, exclude: string[] = []): CandidateMatch[] {
    const out: CandidateMatch[] = [];
    // TODO (scale): block on date of birth year or name keys before scoring once there are many patients.
    for (const p of this.deps.patientsById.values()) {
      if (exclude.includes(p.id) || p.mergedIntoPatientId) continue;
      const { score, breakdown } = scoreMatch(input, this.demographicsOf(p));
      if (score >= CANDIDATE_MIN_SCORE) out.push({ patientId: p.id, score, breakdown });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  /** Puts candidates at or above the threshold in the review queue (once per pair). Never merges. */
  queueReviews(patientId: string, candidates: CandidateMatch[], facilityId: string, source: DuplicateReview['source']): DuplicateReview[] {
    const queued: DuplicateReview[] = [];
    for (const c of candidates) {
      if (c.score < REVIEW_THRESHOLD) continue;
      const pair = [patientId, c.patientId].sort().join('|');
      if ([...this.reviews.values()].some((r) => [r.patientId, r.candidatePatientId].sort().join('|') === pair && r.status !== 'NOT_DUPLICATE')) continue;
      const r: DuplicateReview = {
        id: crypto.randomUUID(), patientId, candidatePatientId: c.patientId, score: c.score, breakdown: c.breakdown,
        facilityId, source, status: 'OPEN', createdAt: new Date().toISOString(),
      };
      this.reviews.set(r.id, r);
      this.persistence?.saveDuplicateReview(r);
      this.audit('MPI_DUPLICATE_QUEUED', 'system', patientId, facilityId, { ipAddress: '127.0.0.1', userAgent: 'Medistry/mpi' }, `Possible duplicate of patient ${c.patientId} (score ${c.score}) queued for review; not merged`);
      queued.push(r);
    }
    return queued;
  }

  private audit(action: string, actorId: string, subjectId: string, facilityId: string | undefined, info: RequestInfo, reason: string): void {
    this.deps.auditManager.appendEntry({ actorId, subjectId, action, accessType: 'SYSTEM_ADMIN', facilityId, ipAddress: info.ipAddress, userAgent: info.userAgent, reason });
  }

  /** The surviving record for an id (follows merges); the id itself if it was not merged. */
  canonical(patientId: string): string {
    let id = patientId;
    for (let i = 0; i < 10; i++) {
      const next = this.deps.patientsById.get(id)?.mergedIntoPatientId;
      if (!next) return id;
      id = next;
    }
    return id;
  }

  /** Ids merged into this survivor (directly or through earlier merges). */
  linkedIds(survivorId: string): string[] {
    const out: string[] = [];
    for (const m of this.merges.values()) {
      if (m.status !== 'ACTIVE' || m.survivorId !== survivorId) continue;
      out.push(m.mergedId, ...this.linkedIds(m.mergedId));
    }
    return out;
  }

  /** Who may act on a pair: a platform admin, or a records officer of a facility involved in it. */
  private authorise(reviewer: UserAccount, facilities: Array<string | undefined>): void {
    const target = reviewer.role === 'RECORDS_OFFICER' ? facilities.find((f) => f && f === reviewer.facilityId) : facilities[0];
    const decision = evaluatePolicy({
      actor: { userId: reviewer.id, role: reviewer.role as any, facilityId: reviewer.facilityId, isVerifiedStaff: true },
      action: 'PATIENT_MERGE', targetFacilityId: target,
    });
    if (!decision.allowed) throw new AuthError(403, decision.reason);
  }

  private facilitiesOf(...ids: string[]): Array<string | undefined> {
    return ids.map((id) => this.deps.patientsById.get(id)?.primaryFacilityId);
  }

  listReviews(reviewer: UserAccount, status = 'OPEN', info: RequestInfo) {
    const visible = [...this.reviews.values()].filter((r) => r.status === status).filter((r) => {
      try { this.authorise(reviewer, [r.facilityId, ...this.facilitiesOf(r.patientId, r.candidatePatientId)]); return true; } catch { return false; }
    });
    if (visible.length) this.audit('MPI_REVIEWS_VIEWED', reviewer.id, visible[0].patientId, reviewer.facilityId, info, `${visible.length} duplicate review(s) listed with demographics`);
    const show = (id: string) => {
      const p = this.deps.patientsById.get(id)!;
      const d = this.demographicsOf(p);
      return { patientId: id, name: d.name, dob: d.dob, gender: d.gender, phone: d.phone ? `${d.phone.slice(0, 4)}•••${d.phone.slice(-3)}` : null, primaryFacilityId: p.primaryFacilityId || null };
    };
    return visible.map((r) => ({ ...r, patient: show(r.patientId), candidate: show(r.candidatePatientId) }));
  }

  dismiss(reviewer: UserAccount, reviewId: string, info: RequestInfo): DuplicateReview {
    const r = this.reviews.get(reviewId);
    if (!r) throw new AuthError(404, 'Review not found');
    this.authorise(reviewer, [r.facilityId, ...this.facilitiesOf(r.patientId, r.candidatePatientId)]);
    if (r.status !== 'OPEN') throw new AuthError(409, `This review is already ${r.status}`);
    Object.assign(r, { status: 'NOT_DUPLICATE', reviewedBy: reviewer.id, reviewedAt: new Date().toISOString() });
    this.persistence?.saveDuplicateReview(r);
    this.audit('MPI_NOT_DUPLICATE', reviewer.id, r.patientId, r.facilityId, info, `Reviewed: not a duplicate of patient ${r.candidatePatientId}`);
    return r;
  }

  /**
   * Links `mergedId` under `survivorId`. Records are not moved or changed: the link is the only change, so it can
   * be undone exactly. Neither record may already be merged away, and the merged record may not be a survivor.
   */
  merge(reviewer: UserAccount, input: { reviewId?: string; survivorId?: string; mergedId?: string }, info: RequestInfo): PatientMerge {
    const review = input.reviewId ? this.reviews.get(input.reviewId) : undefined;
    if (input.reviewId && !review) throw new AuthError(404, 'Review not found');
    if (review && review.status !== 'OPEN') throw new AuthError(409, `This review is already ${review.status}`);
    // Default survivor: the older (existing) record.
    const survivorId = input.survivorId || review?.candidatePatientId;
    const mergedId = input.mergedId || (review ? (survivorId === review.patientId ? review.candidatePatientId : review.patientId) : undefined);
    const survivor = survivorId ? this.deps.patientsById.get(survivorId) : undefined;
    const merged = mergedId ? this.deps.patientsById.get(mergedId) : undefined;
    if (!survivor || !merged || survivor.id === merged.id) throw new AuthError(400, 'Give two different existing patients');
    if (review && ![review.patientId, review.candidatePatientId].includes(survivor.id)) throw new AuthError(400, 'The survivor must be one of the two records in the review');
    this.authorise(reviewer, [review?.facilityId, ...this.facilitiesOf(survivor.id, merged.id)]);
    if (survivor.mergedIntoPatientId || merged.mergedIntoPatientId) throw new AuthError(409, 'One of these records is already merged into another');
    if (this.linkedIds(merged.id).length) throw new AuthError(409, 'Records are merged into this one; unmerge them first');

    merged.mergedIntoPatientId = survivor.id;
    this.persistence?.savePatient(merged);
    const m: PatientMerge = { id: crypto.randomUUID(), survivorId: survivor.id, mergedId: merged.id, reviewId: review?.id, mergedBy: reviewer.id, mergedAt: new Date().toISOString(), status: 'ACTIVE' };
    this.merges.set(m.id, m);
    this.persistence?.savePatientMerge(m);
    if (review) {
      Object.assign(review, { status: 'MERGED', reviewedBy: reviewer.id, reviewedAt: m.mergedAt });
      this.persistence?.saveDuplicateReview(review);
    }
    for (const subject of [survivor.id, merged.id]) {
      this.audit('PATIENT_MERGED', reviewer.id, subject, reviewer.facilityId, info, `Patient ${merged.id} linked under surviving patient ${survivor.id} (merge ${m.id}); both histories kept`);
    }
    return m;
  }

  /** Removes a merge link: both records are as they were before the merge. */
  unmerge(reviewer: UserAccount, mergeId: string, info: RequestInfo): PatientMerge {
    const m = this.merges.get(mergeId);
    if (!m) throw new AuthError(404, 'Merge not found');
    this.authorise(reviewer, this.facilitiesOf(m.survivorId, m.mergedId));
    if (m.status !== 'ACTIVE') throw new AuthError(409, 'This merge was already undone');
    const merged = this.deps.patientsById.get(m.mergedId)!;
    delete merged.mergedIntoPatientId;
    this.persistence?.savePatient(merged);
    Object.assign(m, { status: 'UNDONE', unmergedBy: reviewer.id, unmergedAt: new Date().toISOString() });
    this.persistence?.savePatientMerge(m);
    const review = m.reviewId ? this.reviews.get(m.reviewId) : undefined;
    if (review) {
      // Back in the queue, as it was before the merge.
      review.status = 'OPEN';
      delete review.reviewedBy;
      delete review.reviewedAt;
      this.persistence?.saveDuplicateReview(review);
    }
    for (const subject of [m.survivorId, m.mergedId]) {
      this.audit('PATIENT_UNMERGED', reviewer.id, subject, reviewer.facilityId, info, `Merge ${m.id} undone: patient ${m.mergedId} is separate from ${m.survivorId} again`);
    }
    return m;
  }

  getMerge(id: string): PatientMerge | undefined {
    return this.merges.get(id);
  }
}
