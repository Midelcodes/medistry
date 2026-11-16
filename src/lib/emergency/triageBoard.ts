/**
 * MEDISTRY Triage Board
 * Results of the triage agent (MCP server in /mcp) shown to clinicians as a queue sorted by urgency.
 *
 * A triage result is DECISION SUPPORT, never a clinical record: it is stored here, beside the record, and is
 * never written into the clinical store or the emergency card. It is posted by a verified clinician's session
 * against an active break-glass grant they own, so the patient is already identified, the access is already
 * audited and the patient already notified. Each write and each accepted referral adds an audit entry.
 *
 * The board shows a pseudonymous reference and the minimised essentials the agent already uses, never names
 * or contact details.
 */
import crypto from 'node:crypto';
import type { AuditChainManager } from '../audit/hashChain.ts';

export const TRIAGE_COLOURS = ['RED', 'ORANGE', 'YELLOW', 'GREEN'] as const;
export type TriageColour = typeof TRIAGE_COLOURS[number];
const RANK: Record<TriageColour, number> = { RED: 0, ORANGE: 1, YELLOW: 2, GREEN: 3 };
const TARGET_MINUTES: Record<TriageColour, number> = { RED: 0, ORANGE: 10, YELLOW: 60, GREEN: 240 };

export interface TriageFactor { name: string; value: string; points: number }
export interface ReferralOption { facilityId: string; name: string; distanceKm: number; level: string; icuBedsFree: number }
export interface AcceptedReferral { facilityId: string; name: string; acceptedBy: string; acceptedByName: string; acceptedAt: string }

export interface TriageResult {
  id: string;
  patientId: string;
  patientRef: string;        // pseudonymous, e.g. PT-8f8da317
  facilityId: string;
  clinicianId: string;
  grantId: string;
  agentRunId: string;
  colour: TriageColour;
  tews: number;
  targetMinutes: number;
  factors: TriageFactor[];
  reasons: string[];
  essentials: { age: number | null; gender: string | null; bloodGroup: string | null; genotype: string | null; alerts: string[] };
  referralOptions: ReferralOption[];
  handoverText: string;
  deterioration: { deteriorating: boolean; flags: string[] } | null;
  // Measured by the agent harness for the run that produced this result (shown on the board).
  agentMetrics: { model: string; modelCalls: number; toolCalls: number; inputTokens: number; outputTokens: number; costUsd: number | null } | null;
  createdAt: string;
  acceptedReferral: AcceptedReferral | null;
}

export interface TriageRepo { saveTriageResult(r: TriageResult): void }

export class TriageValidationError extends Error {}

const str = (v: unknown, max: number): string => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const num = (v: unknown, lo: number, hi: number, field: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new TriageValidationError(`${field} must be a number from ${lo} to ${hi}`);
  return n;
};
const list = <T>(v: unknown, max: number, field: string, map: (x: any) => T): T[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new TriageValidationError(`${field} must be a list`);
  if (v.length > max) throw new TriageValidationError(`${field} has more than ${max} items`);
  return v.map(map);
};

/** Validates and normalises an agent payload. Throws TriageValidationError. */
export function parseTriagePayload(body: any): Omit<TriageResult, 'id' | 'patientId' | 'facilityId' | 'clinicianId' | 'grantId' | 'createdAt' | 'acceptedReferral'> {
  if (!body || typeof body !== 'object') throw new TriageValidationError('Body must be a JSON object');
  const colour = String(body.colour || '').toUpperCase() as TriageColour;
  if (!TRIAGE_COLOURS.includes(colour)) throw new TriageValidationError(`colour must be one of ${TRIAGE_COLOURS.join(', ')}`);
  const tews = num(body.tews, 0, 20, 'tews');
  const essentials = body.essentials && typeof body.essentials === 'object' ? body.essentials : {};
  const ageRaw = essentials.age;
  return {
    patientRef: str(body.patientRef, 40) || 'PT-UNKNOWN',
    agentRunId: str(body.agentRunId, 80) || crypto.randomUUID(),
    colour,
    tews,
    // The target time follows the colour (SATS), whatever the payload says.
    targetMinutes: TARGET_MINUTES[colour],
    factors: list(body.factors, 12, 'factors', (f) => ({ name: str(f?.name, 40), value: str(f?.value, 40), points: num(f?.points, 0, 10, 'factor points') })),
    reasons: list(body.reasons, 10, 'reasons', (r) => str(r, 200)),
    essentials: {
      age: ageRaw === null || ageRaw === undefined || ageRaw === '' ? null : num(ageRaw, 0, 130, 'age'),
      gender: essentials.gender ? str(essentials.gender, 20) : null,
      bloodGroup: essentials.bloodGroup ? str(essentials.bloodGroup, 20) : null,
      genotype: essentials.genotype ? str(essentials.genotype, 10) : null,
      alerts: list(essentials.alerts, 10, 'alerts', (a) => str(a, 200)),
    },
    referralOptions: list(body.referralOptions, 5, 'referralOptions', (o) => {
      const facilityId = str(o?.facilityId, 60);
      if (!facilityId) throw new TriageValidationError('Each referral option needs a facilityId');
      return { facilityId, name: str(o?.name, 120) || facilityId, distanceKm: num(o?.distanceKm, 0, 5000, 'distanceKm'), level: str(o?.level, 40), icuBedsFree: num(o?.icuBedsFree ?? 0, 0, 1000, 'icuBedsFree') };
    }),
    handoverText: str(body.handoverText, 8000).replace(/ {2,}/g, ' ') || '',
    agentMetrics: body.agentMetrics && typeof body.agentMetrics === 'object'
      ? {
        model: str(body.agentMetrics.model, 80) || 'unknown',
        modelCalls: num(body.agentMetrics.modelCalls ?? 0, 0, 100, 'modelCalls'),
        toolCalls: num(body.agentMetrics.toolCalls ?? 0, 0, 200, 'toolCalls'),
        inputTokens: num(body.agentMetrics.inputTokens ?? 0, 0, 10_000_000, 'inputTokens'),
        outputTokens: num(body.agentMetrics.outputTokens ?? 0, 0, 10_000_000, 'outputTokens'),
        costUsd: body.agentMetrics.costUsd === null || body.agentMetrics.costUsd === undefined ? null : num(body.agentMetrics.costUsd, 0, 1000, 'costUsd'),
      }
      : null,
    deterioration: body.deterioration && typeof body.deterioration === 'object'
      ? { deteriorating: body.deterioration.deteriorating === true, flags: list(body.deterioration.flags, 10, 'deterioration flags', (f) => str(f, 200)) }
      : null,
  };
}

export class TriageBoardStore {
  private results = new Map<string, TriageResult>();
  /** Write-through repository (no-op in memory storage). */
  persistence?: TriageRepo;
  private deps: { auditManager: AuditChainManager };

  constructor(deps: { auditManager: AuditChainManager }) {
    this.deps = deps;
  }

  hydrate(results: TriageResult[]): void {
    for (const r of results) this.results.set(r.id, r);
  }

  create(input: { patientId: string; facilityId: string; clinicianId: string; clinicianUserId: string; grantId: string; payload: unknown;
    ipAddress: string; userAgent: string }): TriageResult {
    const parsed = parseTriagePayload(input.payload);
    // Handover text keeps line breaks; parseTriagePayload flattens control characters, so restore them from the raw text.
    const rawHandover = typeof (input.payload as any)?.handoverText === 'string' ? (input.payload as any).handoverText : '';
    const handoverText = rawHandover.replace(/\r/g, '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').slice(0, 8000);
    const result: TriageResult = {
      ...parsed,
      handoverText,
      id: crypto.randomUUID(),
      patientId: input.patientId,
      facilityId: input.facilityId,
      clinicianId: input.clinicianId,
      grantId: input.grantId,
      createdAt: new Date().toISOString(),
      acceptedReferral: null,
    };
    this.results.set(result.id, result);
    this.persistence?.saveTriageResult?.(result);
    this.deps.auditManager.appendEntry({
      actorId: input.clinicianUserId,
      subjectId: input.patientId,
      action: 'TRIAGE_RESULT_RECORDED',
      accessType: 'EMERGENCY_BREAK_GLASS',
      resourceType: 'TriageResult',
      resourceId: result.id,
      facilityId: input.facilityId,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      reason: `Triage agent result recorded as decision support: ${result.colour} (TEWS ${result.tews}) under break-glass grant ${input.grantId.slice(0, 8)}`,
    });
    return this.copy(result);
  }

  get(id: string): TriageResult | undefined {
    const r = this.results.get(id);
    return r ? this.copy(r) : undefined;
  }

  forPatient(patientId: string): TriageResult[] {
    return [...this.results.values()].filter((r) => r.patientId === patientId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((r) => this.copy(r));
  }

  /**
   * The facility's board: the latest result per patient, RED first, then oldest first within a colour.
   * deteriorating is true when the latest TEWS is higher than an earlier result for that patient in the last 24 h,
   * or when the agent's flag_deterioration step flagged it.
   */
  board(facilityId: string, nowMs = Date.now()): Array<TriageResult & { deteriorating: boolean; previousTews: number | null }> {
    const byPatient = new Map<string, TriageResult[]>();
    for (const r of this.results.values()) {
      if (r.facilityId !== facilityId) continue;
      if (nowMs - Date.parse(r.createdAt) > 24 * 3_600_000) continue;
      const arr = byPatient.get(r.patientId) || [];
      arr.push(r);
      byPatient.set(r.patientId, arr);
    }
    const rows = [...byPatient.values()].map((arr) => {
      arr.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const latest = arr[arr.length - 1];
      const previous = arr.length > 1 ? arr[arr.length - 2] : null;
      const deteriorating = (previous !== null && latest.tews > previous.tews) || latest.deterioration?.deteriorating === true;
      return { ...this.copy(latest), deteriorating, previousTews: previous ? previous.tews : null };
    });
    return rows.sort((a, b) => RANK[a.colour] - RANK[b.colour] || a.createdAt.localeCompare(b.createdAt));
  }

  acceptReferral(id: string, facilityId: string, by: { clinicianId: string; userId: string; name: string; facilityId: string },
    info: { ipAddress: string; userAgent: string }): TriageResult {
    const r = this.results.get(id);
    if (!r) throw new TriageValidationError('Triage result not found');
    if (r.facilityId !== by.facilityId) throw new TriageValidationError('Triage result not found');
    const option = r.referralOptions.find((o) => o.facilityId === facilityId);
    if (!option) throw new TriageValidationError('Choose one of the suggested referral options');
    if (r.acceptedReferral) {
      if (r.acceptedReferral.facilityId === facilityId) return this.copy(r); // idempotent
      throw new TriageValidationError(`A referral to ${r.acceptedReferral.name} was already accepted`);
    }
    r.acceptedReferral = { facilityId, name: option.name, acceptedBy: by.clinicianId, acceptedByName: by.name, acceptedAt: new Date().toISOString() };
    this.persistence?.saveTriageResult?.(r);
    this.deps.auditManager.appendEntry({
      actorId: by.userId,
      subjectId: r.patientId,
      action: 'REFERRAL_ACCEPTED',
      accessType: 'EMERGENCY_BREAK_GLASS',
      resourceType: 'TriageResult',
      resourceId: r.id,
      facilityId: by.facilityId,
      ipAddress: info.ipAddress,
      userAgent: info.userAgent,
      reason: `Clinician accepted the agent's referral suggestion: ${option.name}`,
    });
    return this.copy(r);
  }

  /** For the patient portal: only accepted referrals, without scores or the handover. */
  referralsForPatient(patientId: string): Array<{ facilityName: string; acceptedByName: string; acceptedAt: string }> {
    return [...this.results.values()].filter((r) => r.patientId === patientId && r.acceptedReferral)
      .sort((a, b) => b.acceptedReferral!.acceptedAt.localeCompare(a.acceptedReferral!.acceptedAt))
      .map((r) => ({ facilityName: r.acceptedReferral!.name, acceptedByName: r.acceptedReferral!.acceptedByName, acceptedAt: r.acceptedReferral!.acceptedAt }));
  }

  all(): TriageResult[] {
    return [...this.results.values()].map((r) => this.copy(r));
  }

  private copy(r: TriageResult): TriageResult {
    return JSON.parse(JSON.stringify(r));
  }
}
