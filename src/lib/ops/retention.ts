/**
 * Retention report (Phase 19). REPORT ONLY: it lists what each configured rule WOULD archive and deletes, archives or
 * changes nothing. There is no code path from here that removes data.
 *
 * Every period comes from the environment and has NO default: the retention periods for each record type are a
 * legal decision (TODO: to be confirmed by counsel per country). A rule without a value is reported as "not
 * configured" and selects nothing.
 *
 * Never selected, whatever is configured:
 *   - clinical records and all their versions (the store refuses hard deletes: ERR_HARD_DELETE_PROHIBITED);
 *   - record flags (a patient's correction request is part of the record);
 *   - patient profiles, consents and emergency codes (no rule here yet; TODO counsel).
 */
import type { Runtime } from '../runtime.ts';

const DAY = 86_400_000;

export interface RetentionRule {
  category: string;
  env: string;                  // the variable that sets the period
  unit: 'years' | 'days';
  description: string;
  note?: string;
}

export const RETENTION_RULES: RetentionRule[] = [
  { category: 'auditEntries', env: 'RETENTION_AUDIT_YEARS', unit: 'years', description: 'Audit log entries older than the period',
    note: 'The audit log is a hash chain: archiving a prefix needs a signed checkpoint so the rest still verifies (not built; TODO).' },
  { category: 'offlineScanEvents', env: 'RETENTION_SCAN_EVENT_YEARS', unit: 'years', description: 'Offline card scan events (by upload time)',
    note: 'Each scan also has an audit entry, which follows the audit rule.' },
  { category: 'smsDeliveryRecords', env: 'RETENTION_DELIVERY_DAYS', unit: 'days', description: 'SMS delivery records (phone number, template, status)' },
  { category: 'aiIntakeSessions', env: 'RETENTION_INTAKE_DAYS', unit: 'days', description: 'AI intake sessions and their uploaded photo or voice file (by last update)',
    note: 'Signed records made from a session are clinical records and are never selected.' },
  { category: 'staffInvites', env: 'RETENTION_INVITE_DAYS', unit: 'days', description: 'Staff invitations, used or expired (by the later of use and expiry)' },
  { category: 'rejectedFacilityApplications', env: 'RETENTION_APPLICATION_DAYS', unit: 'days', description: 'Rejected facility applications and their accreditation document (by review time)' },
  { category: 'reviewedAnomalyFlags', env: 'RETENTION_ANOMALY_FLAG_DAYS', unit: 'days', description: 'Audit anomaly flags after review (by review time)' },
];

export const NEVER_SELECTED = [
  { category: 'clinicalRecords', reason: 'Clinical records and their versions are never hard-deleted (ERR_HARD_DELETE_PROHIBITED in src/lib/clinical/store.ts).' },
  { category: 'recordFlags', reason: 'A patient\'s request to correct a record is kept with the record.' },
  { category: 'patients, consents, emergency codes', reason: 'No retention rule yet. TODO: periods to be confirmed by counsel.' },
];

const MAX_IDS = 100;

/** Reads the configured periods (positive numbers only). */
export function retentionConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const r of RETENTION_RULES) {
    const n = Number(env[r.env]);
    out[r.env] = env[r.env] !== undefined && env[r.env] !== '' && Number.isFinite(n) && n > 0 ? n : null;
  }
  return out;
}

type Item = { id: string; at: string | undefined };

/** What would be archived now. Metadata only (ids and times; no names, no contents). */
export function retentionReport(
  rt: Pick<Runtime, 'auditManager' | 'offlineScans' | 'deliveries' | 'intake' | 'onboarding' | 'anomalyAgent'>,
  config: Record<string, number | null> = retentionConfigFromEnv(),
  now = Date.now(),
) {
  const { invites, applications } = rt.onboarding.retentionView();
  const sources: Record<string, () => Item[]> = {
    auditEntries: () => rt.auditManager.getEntries().map((e) => ({ id: e.id, at: e.timestamp })),
    offlineScanEvents: () => rt.offlineScans.allEvents().map((e) => ({ id: e.id, at: e.receivedAt })),
    smsDeliveryRecords: () => rt.deliveries.all().map((d) => ({ id: d.id, at: d.createdAt })),
    aiIntakeSessions: () => rt.intake.retentionView().map((s) => ({ id: s.id, at: s.updatedAt })),
    staffInvites: () => invites.filter((i) => i.usedAt || Date.parse(i.expiresAt) < now)
      .map((i) => ({ id: i.id, at: [i.usedAt, i.expiresAt].filter(Boolean).sort().at(-1) })),
    rejectedFacilityApplications: () => applications.filter((a) => a.status === 'REJECTED').map((a) => ({ id: a.id, at: a.reviewedAt })),
    reviewedAnomalyFlags: () => rt.anomalyAgent.retentionView().filter((f) => f.status !== 'OPEN').map((f) => ({ id: f.id, at: f.reviewedAt })),
  };
  const rules = RETENTION_RULES.map((r) => {
    const period = config[r.env] ?? null;
    const items = sources[r.category]();
    if (period === null) {
      return { category: r.category, description: r.description, setting: r.env, configured: false, period: null, cutoff: null, held: items.length, wouldArchive: 0, oldestSelected: null, ids: [] as string[], idsTruncated: false, note: r.note, todo: 'Period not set. TODO: to be confirmed by counsel.' };
    }
    const cutoff = new Date(now - period * (r.unit === 'years' ? 365.25 : 1) * DAY).toISOString();
    const selected = items.filter((i) => i.at && i.at < cutoff).sort((a, b) => a.at!.localeCompare(b.at!));
    return {
      category: r.category, description: r.description, setting: r.env, configured: true, period: `${period} ${r.unit}`, cutoff,
      held: items.length, wouldArchive: selected.length, oldestSelected: selected[0]?.at ?? null,
      ids: selected.slice(0, MAX_IDS).map((i) => i.id), idsTruncated: selected.length > MAX_IDS, note: r.note,
    };
  });
  return {
    mode: 'REPORT_ONLY' as const,
    generatedAt: new Date(now).toISOString(),
    deletesNothing: true,
    rules,
    neverSelected: NEVER_SELECTED,
  };
}
