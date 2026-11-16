/**
 * Facility usage dashboard (Phase 18): aggregate counts only, computed from the audit log and record metadata.
 * No patient identifiers, names or record content ever leave this function. A metric that cannot be measured from
 * the data held is omitted with the reason, never estimated.
 */
import type { AuditChainManager } from '../audit/hashChain.ts';
import type { ClinicalDataStore } from '../clinical/store.ts';
import type { EmergencyBreakGlassEngine } from '../emergency/breakGlassEngine.ts';

export function facilityUsage(
  deps: { auditManager: AuditChainManager; clinicalStore: ClinicalDataStore; emergencyEngine: EmergencyBreakGlassEngine },
  facilityId: string,
  days: number,
  now = Date.now(),
) {
  const windowDays = Math.min(365, Math.max(1, Math.floor(days) || 30));
  const from = new Date(now - windowDays * 86_400_000).toISOString();
  const entries = deps.auditManager.getEntries().filter((e) => e.facilityId === facilityId && e.timestamp >= from);
  const count = (action: string) => entries.filter((e) => e.action === action).length;

  // Time from break-glass to the first view of the emergency summary, for grants opened in the window.
  const firstView = new Map<string, string>();
  for (const e of deps.auditManager.getEntries()) {
    if (e.action === 'EMERGENCY_SUMMARY_VIEWED' && e.resourceId && !firstView.has(e.resourceId)) firstView.set(e.resourceId, e.timestamp);
  }
  const grants = deps.emergencyEngine.grantsForFacility(facilityId, from);
  const durations = grants.filter((g) => firstView.has(g.id)).map((g) => (Date.parse(firstView.get(g.id)!) - Date.parse(g.grantedAt)) / 1000).filter((s) => s >= 0);
  const { recordsAdded, aiDraftsSigned } = deps.clinicalStore.facilityRecordCounts(facilityId, from);

  return {
    facilityId,
    windowDays,
    from,
    to: new Date(now).toISOString(),
    offlineCardScans: count('OFFLINE_EMERGENCY_SCAN'),
    breakGlassSessions: grants.length,
    recordsAdded,
    aiDraftsSigned,
    averageSecondsScanToSummary: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    scanToSummarySampleSize: durations.length,
    omitted: [
      { metric: 'duplicateTestsAvoided', reason: 'Not measurable from the data Medistry holds (test orders and repeat tests are not recorded), so it is not estimated.' },
    ],
  };
}
