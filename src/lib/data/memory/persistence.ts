/**
 * Memory storage: the in-memory engines are the only store, so the repositories do nothing and there is no
 * snapshot to load. Behaviour is exactly that of the original in-memory runtime (and of `npm test`).
 */
import type { Persistence } from '../repositories.ts';

export function createMemoryPersistence(): Persistence {
  const noop = () => {};
  return {
    mode: 'memory',
    savePatient: noop,
    saveFacility: noop,
    saveClinician: noop,
    saveEmergencyCode: noop,
    saveRecord: noop,
    saveRecordFlag: noop,
    saveConsentRequest: noop,
    saveConsentGrant: noop,
    saveEmergencyGrant: noop,
    saveDispute: noop,
    saveOfflineCard: noop,
    saveScanEvent: noop,
    saveDeviceKey: noop,
    appendAudit: noop,
    saveNotification: noop,
    saveUserAccount: noop,
    saveProxyRelationship: noop,
    saveCredentialDocument: noop,
    saveNotificationDelivery: noop,
    loadSnapshot: async () => null,
    flush: async () => {},
    close: async () => {},
    stats: () => ({ mode: 'memory', pendingWrites: 0, failedWrites: 0 }),
  };
}
