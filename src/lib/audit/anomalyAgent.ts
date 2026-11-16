/**
 * Audit agent (Phase 19): rule-based, explainable anomaly detection over emergency access. It reads metadata only
 * (who, when, where, which patient id) from break-glass grants, offline scan events and record metadata, and puts
 * flags in a review queue for platform admins. It never acts on a flag: no suspension, no notification to the
 * clinician, no score. A human reviews every flag and records a decision.
 *
 * Rules (every threshold is configurable; the defaults are placeholders to be set by clinical governance, TODO):
 *   BREAK_GLASS_PER_SHIFT   more than ANOMALY_BREAK_GLASS_PER_SHIFT emergency accesses by one clinician within
 *                           ANOMALY_SHIFT_HOURS (break-glass sessions and offline card scans both count).
 *   SCAN_WITHOUT_ENCOUNTER  an emergency access with no Encounter recorded for that patient at that facility within
 *                           ANOMALY_ENCOUNTER_HOURS afterwards (checked only once that time has passed).
 *   SCAN_OUTSIDE_COUNTRY    the access was recorded at a facility, or concerned a patient, in a different country
 *                           from the clinician's own facility. Cross-border emergency care is legitimate (the
 *                           patient-carried card); this is only a prompt for review.
 *   REPEATED_PATIENT_SCANS  ANOMALY_REPEAT_COUNT or more emergency accesses to the same patient by the same clinician
 *                           within ANOMALY_REPEAT_HOURS.
 */
import crypto from 'node:crypto';
import type { SeedClinician, SeedFacility } from '../../../prisma/seed.ts';
import type { AuditChainManager } from './hashChain.ts';
import type { EmergencyBreakGlassEngine } from '../emergency/breakGlassEngine.ts';
import type { OfflineScanService } from '../emergency/offlineScans.ts';
import type { ClinicalDataStore } from '../clinical/store.ts';
import { encryptField, decryptField, type PatientEntity } from '../patient/profile.ts';
import type { UserAccount } from '../auth/accounts.ts';
import { AuthError, type RequestInfo } from '../auth/patientAuth.ts';

export const ANOMALY_RULES = ['BREAK_GLASS_PER_SHIFT', 'SCAN_WITHOUT_ENCOUNTER', 'SCAN_OUTSIDE_COUNTRY', 'REPEATED_PATIENT_SCANS'] as const;
export type AnomalyRule = typeof ANOMALY_RULES[number];
export type AnomalyStatus = 'OPEN' | 'DISMISSED' | 'CONFIRMED';

export interface AnomalyFlag {
  id: string;
  rule: AnomalyRule;
  dedupeKey: string;            // the same finding is flagged once
  clinicianId: string;
  facilityId: string;
  eventRefs: string[];          // "grant:<id>" or "scan:<eventId>": the reviewer opens these in the audit log
  windowStart: string;
  windowEnd: string;
  explanation: string;          // why the rule fired, in plain words; no names, no patient identifiers
  status: AnomalyStatus;
  createdAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  encryptedReviewNote?: string; // the reviewer's free text may mention people, so it is stored encrypted
}

export interface AnomalyConfig {
  breakGlassPerShift: number;   // flag when a clinician has MORE than this many emergency accesses in one shift
  shiftHours: number;
  encounterHours: number;
  repeatCount: number;          // flag at this many accesses to the same patient
  repeatHours: number;
  lookbackDays: number;         // how far back each run looks
}

const num = (v: string | undefined, d: number, min: number, max: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

/** TODO (clinical governance): the defaults below are placeholders, not evidence-based thresholds. */
export function anomalyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AnomalyConfig {
  return {
    breakGlassPerShift: num(env.ANOMALY_BREAK_GLASS_PER_SHIFT, 3, 1, 100),
    shiftHours: num(env.ANOMALY_SHIFT_HOURS, 12, 1, 48),
    encounterHours: num(env.ANOMALY_ENCOUNTER_HOURS, 24, 1, 720),
    repeatCount: num(env.ANOMALY_REPEAT_COUNT, 3, 2, 100),
    repeatHours: num(env.ANOMALY_REPEAT_HOURS, 24, 1, 720),
    lookbackDays: num(env.ANOMALY_LOOKBACK_DAYS, 30, 1, 365),
  };
}

/** One emergency access, normalised from a break-glass grant or an offline scan event. */
export interface EmergencyAccess {
  ref: string;
  kind: 'break-glass' | 'offline-scan';
  clinicianId: string;
  patientId: string;
  facilityId: string;
  at: string;
  patientCountry?: string;
}

export interface AnomalyRepo { saveAnomalyFlag(f: AnomalyFlag): void }

const HOUR = 3_600_000;

export class AuditAnomalyAgent {
  private flags = new Map<string, AnomalyFlag>();
  /** Write-through repository (no-op in memory storage). */
  persistence?: AnomalyRepo;
  private deps: {
    auditManager: AuditChainManager;
    emergencyEngine: EmergencyBreakGlassEngine;
    offlineScans: OfflineScanService;
    clinicalStore: ClinicalDataStore;
    clinicians: SeedClinician[];
    facilities: SeedFacility[];
    patientsById: Map<string, PatientEntity>;
  };
  config: AnomalyConfig;

  constructor(deps: AuditAnomalyAgent['deps'], config: AnomalyConfig = anomalyConfigFromEnv()) {
    this.deps = deps;
    this.config = config;
  }

  hydrate(rows: AnomalyFlag[]): void {
    for (const f of rows) this.flags.set(f.id, f);
  }

  private country(facilityId: string | undefined): string | undefined {
    return this.deps.facilities.find((f) => f.id === facilityId)?.countryCode;
  }

  /** Emergency accesses in the look-back window, oldest first. */
  accesses(now = Date.now()): EmergencyAccess[] {
    const since = new Date(now - this.config.lookbackDays * 24 * HOUR).toISOString();
    const out: EmergencyAccess[] = [];
    for (const g of this.deps.emergencyEngine.grantsSince(since)) {
      out.push({ ref: `grant:${g.id}`, kind: 'break-glass', clinicianId: g.clinicianId, patientId: g.patientId, facilityId: g.facilityId, at: g.grantedAt, patientCountry: this.deps.patientsById.get(g.patientId)?.countryCode });
    }
    for (const e of this.deps.offlineScans.allEvents()) {
      if (e.scannedAt < since) continue;
      out.push({ ref: `scan:${e.id}`, kind: 'offline-scan', clinicianId: e.clinicianId, patientId: e.patientId, facilityId: e.facilityId, at: e.scannedAt, patientCountry: e.cardCountry });
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  /** Runs every rule and returns what they find. Pure: stores nothing. */
  evaluate(now = Date.now()): Array<Omit<AnomalyFlag, 'id' | 'status' | 'createdAt'>> {
    const c = this.config;
    const all = this.accesses(now);
    const found: Array<Omit<AnomalyFlag, 'id' | 'status' | 'createdAt'>> = [];
    const clinician = (id: string) => this.deps.clinicians.find((x) => x.id === id);
    const add = (rule: AnomalyRule, group: EmergencyAccess[], explanation: string) => {
      const first = group[0];
      found.push({
        rule, dedupeKey: `${rule}|${first.clinicianId}|${first.ref}`, clinicianId: first.clinicianId,
        facilityId: clinician(first.clinicianId)?.facilityId || first.facilityId,
        eventRefs: group.map((a) => a.ref), windowStart: first.at, windowEnd: group.at(-1)!.at, explanation,
      });
    };
    // Groups of accesses within `hours` of the first one, at least `min` long; a group is reported once.
    const windows = (list: EmergencyAccess[], hours: number, min: number) => {
      const groups: EmergencyAccess[][] = [];
      for (let i = 0; i < list.length;) {
        let j = i;
        while (j + 1 < list.length && Date.parse(list[j + 1].at) - Date.parse(list[i].at) <= hours * HOUR) j++;
        if (j - i + 1 >= min) { groups.push(list.slice(i, j + 1)); i = j + 1; } else i++;
      }
      return groups;
    };
    const byClinician = new Map<string, EmergencyAccess[]>();
    for (const a of all) byClinician.set(a.clinicianId, [...(byClinician.get(a.clinicianId) || []), a]);

    for (const [clinicianId, list] of byClinician) {
      // 1. Too many emergency accesses in one shift.
      for (const g of windows(list, c.shiftHours, c.breakGlassPerShift + 1)) {
        add('BREAK_GLASS_PER_SHIFT', g, `${g.length} emergency accesses (${g.filter((a) => a.kind === 'break-glass').length} break-glass, ${g.filter((a) => a.kind === 'offline-scan').length} offline scans) within ${c.shiftHours} hours; the threshold is more than ${c.breakGlassPerShift} per shift.`);
      }
      // 4. The same patient again and again.
      const byPatient = new Map<string, EmergencyAccess[]>();
      for (const a of list) byPatient.set(a.patientId, [...(byPatient.get(a.patientId) || []), a]);
      for (const pl of byPatient.values()) {
        for (const g of windows(pl, c.repeatHours, c.repeatCount)) {
          add('REPEATED_PATIENT_SCANS', g, `${g.length} emergency accesses to the same patient within ${c.repeatHours} hours; the threshold is ${c.repeatCount}.`);
        }
      }
      const home = this.country(clinician(clinicianId)?.facilityId);
      for (const a of list) {
        // 2. No encounter recorded afterwards (only once the waiting time has passed).
        const deadline = Date.parse(a.at) + c.encounterHours * HOUR;
        if (deadline <= now && !this.deps.clinicalStore.hasEncounterBetween(a.patientId, a.facilityId, a.at, new Date(deadline).toISOString())) {
          add('SCAN_WITHOUT_ENCOUNTER', [a], `${a.kind === 'break-glass' ? 'Break-glass session' : 'Offline card scan'} with no encounter recorded for that patient at that facility within ${c.encounterHours} hours.`);
        }
        // 3. Outside the clinician's facility country.
        const where = this.country(a.facilityId);
        const reasons: string[] = [];
        if (home && where && where !== home) reasons.push(`recorded at a facility in ${where}`);
        if (home && a.patientCountry && a.patientCountry !== home) reasons.push(`the patient's record is from ${a.patientCountry}`);
        if (reasons.length) {
          add('SCAN_OUTSIDE_COUNTRY', [a], `${a.kind === 'break-glass' ? 'Break-glass session' : 'Offline card scan'} by a clinician whose facility is in ${home}: ${reasons.join(' and ')}. Cross-border emergency care can be legitimate; review the reason given.`);
        }
      }
    }
    return found;
  }

  /** Stores new findings as OPEN flags (once each) and audits them. Returns the new flags. */
  run(now = Date.now()): AnomalyFlag[] {
    const known = new Set([...this.flags.values()].map((f) => f.dedupeKey));
    const created: AnomalyFlag[] = [];
    for (const f of this.evaluate(now)) {
      if (known.has(f.dedupeKey)) continue;
      known.add(f.dedupeKey);
      const flag: AnomalyFlag = { ...f, id: crypto.randomUUID(), status: 'OPEN', createdAt: new Date(now).toISOString() };
      this.flags.set(flag.id, flag);
      this.persistence?.saveAnomalyFlag(flag);
      this.deps.auditManager.appendEntry({
        actorId: 'audit-agent', action: 'ANOMALY_FLAGGED', accessType: 'SYSTEM_ADMIN', resourceType: 'AnomalyFlag', resourceId: flag.id,
        facilityId: flag.facilityId, ipAddress: 'internal', userAgent: 'audit-agent', reason: `${flag.rule} for clinician ${flag.clinicianId}; queued for human review`,
      });
      created.push(flag);
    }
    return created;
  }

  private platformOnly(admin: UserAccount): void {
    if (admin.role !== 'PLATFORM_ADMIN') throw new AuthError(403, 'Platform admins review audit flags');
  }

  private view(f: AnomalyFlag) {
    const { encryptedReviewNote, dedupeKey: _key, ...rest } = f;
    return { ...rest, reviewNote: encryptedReviewNote ? decryptField(encryptedReviewNote) : undefined };
  }

  list(admin: UserAccount, status: string = 'OPEN') {
    this.platformOnly(admin);
    return [...this.flags.values()].filter((f) => status === 'ALL' || f.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((f) => this.view(f));
  }

  /**
   * A platform admin records a decision. CONFIRMED means "needs follow-up by clinical governance"; nothing happens
   * automatically to the clinician either way.
   */
  review(admin: UserAccount, id: string, decision: unknown, note: unknown, info: RequestInfo) {
    this.platformOnly(admin);
    const f = this.flags.get(id);
    if (!f) throw new AuthError(404, 'Flag not found');
    if (f.status !== 'OPEN') throw new AuthError(409, 'This flag has already been reviewed');
    if (decision !== 'dismiss' && decision !== 'confirm') throw new AuthError(400, 'decision must be dismiss or confirm');
    const text = String(note ?? '').trim().slice(0, 1000);
    if (text.length < 5) throw new AuthError(400, 'Write a short note explaining the decision');
    f.status = decision === 'confirm' ? 'CONFIRMED' : 'DISMISSED';
    f.reviewedBy = admin.id;
    f.reviewedAt = new Date().toISOString();
    f.encryptedReviewNote = encryptField(text);
    this.persistence?.saveAnomalyFlag(f);
    this.deps.auditManager.appendEntry({
      actorId: admin.id, action: 'ANOMALY_FLAG_REVIEWED', accessType: 'SYSTEM_ADMIN', resourceType: 'AnomalyFlag', resourceId: f.id,
      facilityId: f.facilityId, ipAddress: info.ipAddress, userAgent: info.userAgent, reason: `${f.rule} flag ${f.status.toLowerCase()} by a platform admin (no automatic action)`,
    });
    return this.view(f);
  }

  /** Reviewed flags, for the retention report. */
  retentionView(): Array<{ id: string; status: AnomalyStatus; reviewedAt?: string }> {
    return [...this.flags.values()].map((f) => ({ id: f.id, status: f.status, reviewedAt: f.reviewedAt }));
  }
}
